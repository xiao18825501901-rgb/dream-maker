package dmbridge

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"time"
)

var physicalDenied = errors.New("DM_MAGPIE_PHYSICAL_REQUEST_DENIED")

type physicalContextKey struct{}
type physicalAttempt struct {
	admission Admission
	used      atomic.Bool
	now       func() time.Time
}

func withPhysicalAttempt(ctx context.Context, a Admission, now func() time.Time) context.Context {
	return context.WithValue(ctx, physicalContextKey{}, &physicalAttempt{admission: a, now: now})
}

// SinglePhysicalTransport consumes this ingress's already-reserved physical call before
// network I/O. An ambiguous send burns the capability; retries need a new Engine hold.
// Next must itself be non-replaying. The dedicated gateway constructor supplies it.
type SinglePhysicalTransport struct {
	Next  http.RoundTripper
	Check func(Admission, *http.Request) error
}

func (t *SinglePhysicalTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r == nil || t.Next == nil || t.Check == nil {
		return nil, physicalDenied
	}
	scope, ok := r.Context().Value(physicalContextKey{}).(*physicalAttempt)
	if !ok || scope == nil || r.Context().Err() != nil || scope.now().UnixMilli() >= scope.admission.ExpiresAtMs {
		return nil, physicalDenied
	}
	if t.Check(scope.admission, r) != nil || r.Context().Err() != nil || scope.now().UnixMilli() >= scope.admission.ExpiresAtMs || !scope.used.CompareAndSwap(false, true) {
		return nil, physicalDenied
	}
	out := r.Clone(r.Context())
	out.GetBody = nil
	return t.Next.RoundTrip(out)
}
