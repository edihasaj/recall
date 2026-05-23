package webui

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// fakeDaemon mirrors the subset of /webui/* the tray hits. Lets us drive
// the manager through real HTTP without spinning a real recall daemon.
type fakeDaemon struct {
	mu      *atomic.Pointer[Status]
	starts  atomic.Int32
	stops   atomic.Int32
	statuss atomic.Int32
}

func newFake() (*httptest.Server, *fakeDaemon) {
	f := &fakeDaemon{mu: &atomic.Pointer[Status]{}}
	f.mu.Store(&Status{Running: false})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/webui/status" && r.Method == http.MethodGet:
			f.statuss.Add(1)
			_ = json.NewEncoder(w).Encode(f.mu.Load())
		case r.URL.Path == "/webui/start" && r.Method == http.MethodPost:
			f.starts.Add(1)
			port := 7891
			f.mu.Store(&Status{Running: true, Port: &port, URL: "http://localhost:7891", ClientCount: 0})
			_ = json.NewEncoder(w).Encode(f.mu.Load())
		case r.URL.Path == "/webui/stop" && r.Method == http.MethodPost:
			f.stops.Add(1)
			f.mu.Store(&Status{Running: false})
			_ = json.NewEncoder(w).Encode(f.mu.Load())
		default:
			http.NotFound(w, r)
		}
	}))
	return srv, f
}

func TestRefreshReadsStatus(t *testing.T) {
	srv, _ := newFake()
	defer srv.Close()
	m := New(srv.URL)
	st, err := m.Refresh(context.Background())
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if st.Running {
		t.Fatalf("expected not running, got %+v", st)
	}
	cached, ok := m.Status()
	if !ok || cached.Running {
		t.Fatalf("cached status mismatch: ok=%v st=%+v", ok, cached)
	}
}

func TestStartStopRoundTrip(t *testing.T) {
	srv, f := newFake()
	defer srv.Close()
	m := New(srv.URL)
	if st, err := m.Start(context.Background()); err != nil || !st.Running {
		t.Fatalf("start: err=%v st=%+v", err, st)
	}
	if got := f.starts.Load(); got != 1 {
		t.Fatalf("expected 1 start, got %d", got)
	}
	if st, err := m.Stop(context.Background()); err != nil || st.Running {
		t.Fatalf("stop: err=%v st=%+v", err, st)
	}
	if got := f.stops.Load(); got != 1 {
		t.Fatalf("expected 1 stop, got %d", got)
	}
}

func TestWatchFiresOnRunningFlip(t *testing.T) {
	srv, f := newFake()
	defer srv.Close()
	m := New(srv.URL)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	changes := make(chan Status, 4)
	go m.Watch(ctx, 20*time.Millisecond, func(st Status, ok bool) {
		if ok {
			changes <- st
		}
	})

	// First poll: running=false. Flip server state to running and expect a
	// change notification on the next tick.
	first := <-changes
	if first.Running {
		t.Fatalf("expected initial not-running, got %+v", first)
	}
	port := 7891
	f.mu.Store(&Status{Running: true, Port: &port, ClientCount: 2})

	select {
	case st := <-changes:
		if !st.Running || st.ClientCount != 2 {
			t.Fatalf("expected running w/ 2 clients, got %+v", st)
		}
	case <-time.After(time.Second):
		t.Fatalf("Watch did not fire after flip")
	}
}
