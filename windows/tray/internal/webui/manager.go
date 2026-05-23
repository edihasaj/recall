// Package webui drives the recall daemon's /webui/* endpoints from the tray.
// The daemon owns the actual webui HTTP server (port 7891 by default); this
// manager just polls /webui/status and posts to /webui/start | /webui/stop.
//
// Mirrors macos/RecallApp/Recall/WebUIController.swift so the menu surface
// stays consistent across platforms.
package webui

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Status mirrors WebUIServerStatus in src/webui/server.ts. Only fields the
// tray actually uses are decoded; the rest is ignored via the decoder's
// default ignore-unknown behaviour.
type Status struct {
	Running     bool   `json:"running"`
	Port        *int   `json:"port"`
	URL         string `json:"url"`
	ClientCount int    `json:"client_count"`
}

// Manager wraps the http client + last-known status. Cheap to construct;
// the tray builds one and shares it with the Watch loop.
type Manager struct {
	BaseURL string // e.g. http://localhost:7890
	client  *http.Client

	mu     sync.Mutex
	last   Status
	lastOK bool
}

// New builds a Manager pointing at the daemon on baseURL. A short timeout
// keeps a hung daemon from blocking the tray's UI thread.
func New(baseURL string) *Manager {
	return &Manager{
		BaseURL: baseURL,
		client:  &http.Client{Timeout: 2 * time.Second},
	}
}

// Status returns the most recent status the Watch loop has observed. Safe
// to call from the UI goroutine.
func (m *Manager) Status() (Status, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.last, m.lastOK
}

// Refresh polls /webui/status once and updates the cached value.
func (m *Manager) Refresh(ctx context.Context) (Status, error) {
	st, err := m.fetchStatus(ctx)
	m.mu.Lock()
	if err == nil {
		m.last = st
		m.lastOK = true
	} else {
		m.lastOK = false
	}
	m.mu.Unlock()
	return st, err
}

// Start posts to /webui/start. open=false because the tray drives browser
// launch itself via the dashboard package; we just want the server up.
func (m *Manager) Start(ctx context.Context) (Status, error) {
	return m.postStatus(ctx, "/webui/start", map[string]any{"open": false})
}

// Stop posts to /webui/stop.
func (m *Manager) Stop(ctx context.Context) (Status, error) {
	return m.postStatus(ctx, "/webui/stop", nil)
}

// Watch polls /webui/status every interval until ctx is done, calling
// onChange whenever the cached Status materially differs from the previous
// observation (running flip or client_count change). Lets the tray repaint
// the menu cheaply without busy-looping.
func (m *Manager) Watch(ctx context.Context, interval time.Duration, onChange func(Status, bool)) {
	var prev Status
	var prevOK bool
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		st, err := m.Refresh(ctx)
		ok := err == nil
		if ok != prevOK || st.Running != prev.Running || st.ClientCount != prev.ClientCount {
			onChange(st, ok)
			prev, prevOK = st, ok
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (m *Manager) fetchStatus(ctx context.Context) (Status, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.BaseURL+"/webui/status", nil)
	if err != nil {
		return Status{}, err
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return Status{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Status{}, fmt.Errorf("webui status: http %d", resp.StatusCode)
	}
	var st Status
	if err := json.NewDecoder(resp.Body).Decode(&st); err != nil {
		return Status{}, err
	}
	return st, nil
}

func (m *Manager) postStatus(ctx context.Context, path string, body any) (Status, error) {
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			return Status{}, err
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.BaseURL+path, &buf)
	if err != nil {
		return Status{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := m.client.Do(req)
	if err != nil {
		return Status{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Status{}, fmt.Errorf("webui %s: http %d", path, resp.StatusCode)
	}
	var st Status
	if err := json.NewDecoder(resp.Body).Decode(&st); err != nil {
		return Status{}, err
	}
	m.mu.Lock()
	m.last, m.lastOK = st, true
	m.mu.Unlock()
	return st, nil
}
