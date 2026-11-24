package dmbridge

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type physicalFunc func(*http.Request) (*http.Response, error)

func (f physicalFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Synthetic transport only: proves physical-call bounds, never provider/role Live.
func TestPhysicalAttemptDoesNotRetryAnUncertainSend(t *testing.T) {
	var calls atomic.Int32
	transport := &SinglePhysicalTransport{Next: physicalFunc(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return nil, errors.New("SYNTHETIC_AFTER_SEND_FAILURE")
	}), Check: func(a Admission, r *http.Request) error {
		if a.ID != "req-1" || a.ReservationID != "reserved-1" {
			return errors.New("SCOPE")
		}
		return nil
	}}
	g := fixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for i := 0; i < 3; i++ {
			out, _ := http.NewRequestWithContext(r.Context(), "POST", "https://api.deepseek.com/chat/completions", strings.NewReader(`{"model":"model-a"}`))
			_, err := transport.RoundTrip(out)
			if err == nil {
				t.Error("uncertain request unexpectedly succeeded")
			}
		}
		w.WriteHeader(502)
	}))
	a := sample()
	if err := g.Grant(a); err != nil {
		t.Fatal(err)
	}
	g.ServeHTTP(httptest.NewRecorder(), request(a, payload))
	if calls.Load() != 1 {
		t.Fatalf("physical sends=%d", calls.Load())
	}
}
func TestPhysicalAttemptIsAtomicAcrossConcurrentBranches(t *testing.T) {
	var calls atomic.Int32
	transport := &SinglePhysicalTransport{Next: physicalFunc(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("SYNTHETIC"))}, nil
	}), Check: func(Admission, *http.Request) error { return nil }}
	g := fixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var group sync.WaitGroup
		for i := 0; i < 16; i++ {
			group.Add(1)
			go func() {
				defer group.Done()
				out, _ := http.NewRequestWithContext(r.Context(), "POST", "https://api.deepseek.com/chat/completions", strings.NewReader(`{}`))
				res, _ := transport.RoundTrip(out)
				if res != nil {
					res.Body.Close()
				}
			}()
		}
		group.Wait()
		w.WriteHeader(200)
	}))
	a := sample()
	if err := g.Grant(a); err != nil {
		t.Fatal(err)
	}
	g.ServeHTTP(httptest.NewRecorder(), request(a, payload))
	if calls.Load() != 1 {
		t.Fatalf("physical sends=%d", calls.Load())
	}
}
func TestPhysicalAttemptRequiresGateContextAndRechecksCancellation(t *testing.T) {
	var calls atomic.Int32
	transport := &SinglePhysicalTransport{Next: physicalFunc(func(*http.Request) (*http.Response, error) { calls.Add(1); return nil, nil }), Check: func(Admission, *http.Request) error { return nil }}
	out, _ := http.NewRequest("POST", "https://api.deepseek.com/chat/completions", strings.NewReader(`{}`))
	if _, err := transport.RoundTrip(out); err == nil {
		t.Fatal("unscoped send allowed")
	}
	g := fixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithCancel(r.Context())
		cancel()
		out, _ := http.NewRequestWithContext(ctx, "POST", "https://api.deepseek.com/chat/completions", strings.NewReader(`{}`))
		if _, err := transport.RoundTrip(out); err == nil {
			t.Error("cancelled send allowed")
		}
		w.WriteHeader(200)
	}))
	a := sample()
	if err := g.Grant(a); err != nil {
		t.Fatal(err)
	}
	g.ServeHTTP(httptest.NewRecorder(), request(a, payload))
	if calls.Load() != 0 {
		t.Fatal("unexpected physical request")
	}
}
func TestPhysicalAttemptChecksActualTargetBeforeSending(t *testing.T) {
	var calls atomic.Int32
	transport := &SinglePhysicalTransport{Next: physicalFunc(func(*http.Request) (*http.Response, error) { calls.Add(1); return nil, nil }), Check: func(a Admission, r *http.Request) error {
		if r.URL.Host != "api.deepseek.com" || a.ExpiresAtMs <= time.Now().UnixMilli() {
			return errors.New("TARGET")
		}
		return nil
	}}
	g := fixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		out, _ := http.NewRequestWithContext(r.Context(), "POST", "https://unexpected.invalid/chat/completions", strings.NewReader(`{}`))
		if _, err := transport.RoundTrip(out); err == nil {
			t.Error("wrong target allowed")
		}
		w.WriteHeader(200)
	}))
	a := sample()
	if err := g.Grant(a); err != nil {
		t.Fatal(err)
	}
	g.ServeHTTP(httptest.NewRecorder(), request(a, payload))
	if calls.Load() != 0 {
		t.Fatal("unexpected physical request")
	}
}
