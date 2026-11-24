// DM-only entry. It deliberately does not import cli/plugins/all or call
// gateway.ListenAndServe: no implicit listeners, account keep-alive or updater.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/yetone/magpie/internal/access"
	"github.com/yetone/magpie/internal/appdir"
	"github.com/yetone/magpie/internal/budget"
	"github.com/yetone/magpie/internal/dmbridge"
	"github.com/yetone/magpie/internal/gateway"
	"github.com/yetone/magpie/internal/gwbudget"
	"github.com/yetone/magpie/internal/settings"
)

const commit = "1aca55909ff94f5c23091ce35f73cb4b7bc46658"

// The dedicated entry does not use ListenAndServe or the user-toggleable
// plugin runtime. It serves the same budget limiter unconditionally so a
// DM-issued key can never pass while its declared limit is unenforced.
func installDedicatedKeyLimits() func() {
	return gwbudget.Limit(budget.Limiter{})
}

func authorize(a dmbridge.Admission) error {
	who, err := access.Check(a.UpstreamKey)
	if err != nil || who.KeyID != a.UpstreamKeyID || who.Default || who.Issues || who.Issuer != nil || who.Group != "" || who.AccountModels || len(who.Models) != 1 || who.Models[0] != a.Provider+"/"+a.Model || !dmbridge.AccountScopeMatches(a, who.Accounts) || who.Expires.IsZero() || who.Expires.UnixMilli() < a.ExpiresAtMs {
		return errors.New("UPSTREAM_SCOPE_NOT_VERIFIED")
	}
	return nil
}
func run() error {
	// The owning controller must set discovery OFF before this program's imports initialize.
	if os.Getenv("MAGPIE_NO_ACCOUNTS") != "1" || !settings.AccountDiscoveryOff() {
		return errors.New("DISCOVERY_NOT_DISABLED")
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return err
	}
	expected := filepath.Join(filepath.Dir(exe), "data")
	if !strings.EqualFold(filepath.Clean(appdir.Portable()), filepath.Clean(expected)) || !strings.EqualFold(filepath.Clean(appdir.Config()), filepath.Clean(expected)) {
		return errors.New("DEDICATED_PORTABLE_ROOT_REQUIRED")
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), bootstrapLimit+1)
	if !scanner.Scan() {
		return errors.New("OWNER_CONTROL_REQUIRED")
	}
	boot, err := parseBootstrap(scanner.Bytes())
	if err != nil {
		return errors.New("CONTROL_FRAME_INVALID")
	}
	// Setup precedes settings/provider reads. Accounts arrive only on the owned pipe.
	credentials, err := configureCredentials(boot)
	for i := range boot.Accounts {
		boot.Accounts[i].Key = ""
	}
	boot.Accounts = nil
	if err != nil {
		return err
	}
	if settings.Load().LAN {
		return errors.New("DEDICATED_PORTABLE_ROOT_REQUIRED")
	}
	stopKeyLimits := installDedicatedKeyLimits()
	defer stopKeyLimits()
	issued, err := access.List()
	if err != nil || len(issued) != 0 {
		return errors.New("DM_ISSUED_KEY_STORE_DENIED")
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	if err = os.Setenv("MAGPIE_ADDR", listener.Addr().String()); err != nil {
		return err
	}
	engine := gateway.NewDreamMakerServer()
	gate, err := dmbridge.New(dmbridge.Config{Epoch: boot.Epoch, Authority: listener.Addr().String(), Authorize: credentials.Authorize, ValidateRequest: gateway.CheckDreamMakerIngress, Handler: engine.DreamMakerHandler(), SubscriptionHandler: http.HandlerFunc(engine.CodexPlannerResponses)})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server := &http.Server{Handler: gate, BaseContext: func(net.Listener) context.Context { return ctx }, ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 130 * time.Second, IdleTimeout: 10 * time.Second, MaxHeaderBytes: 16384}
	stopped := make(chan error, 1)
	go func() { stopped <- server.Serve(listener); cancel() }()
	output := json.NewEncoder(os.Stdout)
	registeredAccounts := credentials.Accounts()
	if err = output.Encode(map[string]any{"type": "ready", "schema": "dream-maker.magpie-ingress-candidate.v1", "epoch": boot.Epoch, "controlSchema": boot.Schema, "pid": os.Getpid(), "address": listener.Addr().String(), "commit": commit, "configDir": appdir.Config(), "accountDiscovery": "OFF", "accountCatalog": "MEMORY_ONLY", "accountCount": len(registeredAccounts), "accounts": registeredAccounts, "issuedKeyStore": "MEMORY_ONLY", "issuedKeyCount": len(issued), "qualification": "NOT_VERIFIED", "runtimeAuthority": "ORIGINAL_DREAMFLOW_ENGINE"}); err != nil {
		cancel()
		_ = server.Close()
		return err
	}
	var controlError error
	for scanner.Scan() {
		kind, err := controlCommand(scanner.Bytes())
		if err != nil {
			controlError = errors.New("CONTROL_FRAME_INVALID")
			break
		}
		if kind == "stop" {
			break
		}
		if kind == "issue" {
			ack, issueError := credentials.IssueFrame(scanner.Bytes())
			if issueError != nil {
				controlError = errors.New("CONTROL_FRAME_INVALID")
				break
			}
			if output.Encode(ack) != nil {
				controlError = errors.New("OWNER_CONTROL_LOST")
				break
			}
			continue
		}
		ack, grantError := gate.GrantFrame(scanner.Bytes())
		if grantError != nil {
			controlError = errors.New("CONTROL_FRAME_INVALID")
			break
		}
		if output.Encode(ack) != nil {
			controlError = errors.New("OWNER_CONTROL_LOST")
			break
		}
	}
	if scanner.Err() != nil {
		controlError = errors.New("CONTROL_FRAME_INVALID")
	}
	cancel()
	closing, done := context.WithTimeout(context.Background(), 3*time.Second)
	defer done()
	_ = server.Shutdown(closing)
	_ = server.Close()
	select {
	case <-stopped:
	case <-closing.Done():
		return errors.New("LISTENER_CLEANUP_UNPROVEN")
	}
	return controlError
}
func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println("dream-maker-magpie", commit, "candidate")
		return
	}
	if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "DM_MAGPIE_ARGUMENTS_REFUSED")
		os.Exit(1)
	}
	log.SetOutput(io.Discard) // no provider responses, credentials or shared-account paths in diagnostics
	if run() != nil {
		fmt.Fprintln(os.Stderr, "DM_MAGPIE_START_OR_CONTROL_REFUSED")
		os.Exit(1)
	}
}
