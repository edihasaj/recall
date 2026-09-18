package daemon

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDaemonProcessHelper(t *testing.T) {
	if os.Getenv("RECALL_DAEMON_TEST_HELPER") != "1" {
		return
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	if err := http.ListenAndServe("127.0.0.1:"+os.Getenv("RECALL_PORT"), handler); err != nil {
		os.Exit(2)
	}
}

func managedHelper(t *testing.T) (*Manager, context.Context) {
	t.Helper()
	t.Setenv("RECALL_DAEMON_TEST_HELPER", "1")
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	m := &Manager{NodePath: bin, DaemonJS: "-test.run=^TestDaemonProcessHelper$", Port: port, LogPath: filepath.Join(t.TempDir(), "daemon.log")}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { m.Watch(ctx, 10*time.Millisecond, nil); close(done) }()
	t.Cleanup(func() {
		cancel()
		_ = m.Stop()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("watch did not stop")
		}
	})
	return m, ctx
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition did not become true")
}

func TestUnexpectedExitRecoversButIntentionalStopStaysStopped(t *testing.T) {
	m, ctx := managedHelper(t)
	if err := m.Start(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, m.Healthy)
	m.mu.Lock()
	first := m.cmd
	m.mu.Unlock()
	if err := m.Start(ctx); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	same := m.cmd == first
	m.mu.Unlock()
	if !same {
		t.Fatal("idempotent Start spawned another child")
	}
	if err := first.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { m.mu.Lock(); defer m.mu.Unlock(); return m.cmd != nil && m.cmd != first && m.healthy })
	if err := m.Stop(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cmd != nil || m.wanted {
		t.Fatal("intentional stop was restarted")
	}
}

func TestRestartWaitsForOldChild(t *testing.T) {
	m, ctx := managedHelper(t)
	if err := m.Start(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, m.Healthy)
	m.mu.Lock()
	first := m.cmd
	done := m.done
	m.mu.Unlock()
	if err := m.Restart(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	default:
		t.Fatal("old child has not exited")
	}
	waitFor(t, func() bool { m.mu.Lock(); defer m.mu.Unlock(); return m.cmd != nil && m.cmd != first && m.healthy })
}

func TestRetryBackoffIsBounded(t *testing.T) {
	m := &Manager{}
	for i := 0; i < 15; i++ {
		m.scheduleRetryLocked(os.ErrNotExist)
	}
	delay := time.Until(m.restartAt)
	if delay < 29*time.Second || delay > 30*time.Second {
		t.Fatalf("unexpected backoff: %v", delay)
	}
}

func TestDaemonScriptAtGlobalRoot(t *testing.T) {
	got := daemonScriptAtGlobalRoot(filepath.Join("npm", "node_modules"))
	want := filepath.Join("npm", "node_modules", "@edihasaj", "recall", "dist", "daemon.js")
	if got != want {
		t.Fatalf("daemonScriptAtGlobalRoot() = %q, want %q", got, want)
	}
}

func TestExplicitRuntimeOverridesAreBothHonored(t *testing.T) {
	t.Setenv("RECALL_NODE_PATH", "pinned-node")
	t.Setenv("RECALL_DAEMON_SCRIPT", "pinned-daemon.js")
	m, err := New()
	if err != nil {
		t.Fatal(err)
	}
	if m.NodePath != "pinned-node" || m.DaemonJS != "pinned-daemon.js" {
		t.Fatal("runtime override was ignored")
	}
}

func TestFirstExistingFile(t *testing.T) {
	root := t.TempDir()
	existing := filepath.Join(root, "recall", "dist", "daemon.js")
	if err := os.MkdirAll(filepath.Dir(existing), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(existing, []byte("test"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := firstExistingFile([]string{filepath.Join(root, "missing.js"), existing})
	if err != nil {
		t.Fatal(err)
	}
	if got != existing {
		t.Fatalf("firstExistingFile() = %q, want %q", got, existing)
	}
}

func TestFirstExistingFileRejectsMissingCandidates(t *testing.T) {
	if _, err := firstExistingFile([]string{filepath.Join(t.TempDir(), "missing.js")}); err == nil {
		t.Fatal("firstExistingFile() error = nil, want missing candidate error")
	}
}
