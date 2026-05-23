// Package daemon owns the recall daemon child process: locate the daemon
// script, spawn `node <daemon.js>`, watch /health, surface state for the
// tray to render. The tray app is the daemon's sole supervisor on Windows
// (no launchd/systemd equivalent in the v1 flow), so this package is the
// thing that decides "is recall running?"
package daemon

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

const defaultPort = 7890

// Manager wraps the child process + health probe loop.
type Manager struct {
	NodePath string // default: "node" (resolved via PATH)
	DaemonJS string // absolute path to dist/daemon.js
	Port     int    // default: 7890
	LogPath  string // where to tee stdout/stderr

	mu      sync.Mutex
	cmd     *exec.Cmd
	healthy bool
	lastErr error
}

// New returns a Manager with defaults filled in. Resolution order for the
// daemon script:
//  1. $RECALL_DAEMON_SCRIPT env var (escape hatch).
//  2. Resolved via `node -e "console.log(require.resolve('@edihasaj/recall/package.json'))"`,
//     then sibling dist/daemon.js.
//  3. Fall back to first match in well-known npm-global locations.
//
// Step 2 keeps the tray honest about which install it's binding to.
func New() (*Manager, error) {
	m := &Manager{
		NodePath: "node",
		Port:     defaultPort,
		LogPath:  filepath.Join(os.Getenv("LOCALAPPDATA"), "Recall", "daemon.log"),
	}
	if env := os.Getenv("RECALL_DAEMON_SCRIPT"); env != "" {
		m.DaemonJS = env
		return m, nil
	}
	if env := os.Getenv("RECALL_NODE_PATH"); env != "" {
		m.NodePath = env
	}
	js, err := resolveDaemonScript(m.NodePath)
	if err != nil {
		return nil, fmt.Errorf("recall daemon script not found: %w (install with `npm install -g @edihasaj/recall`, or set RECALL_DAEMON_SCRIPT)", err)
	}
	m.DaemonJS = js
	return m, nil
}

// resolveDaemonScript asks Node to tell us where the recall package lives,
// then composes dist/daemon.js relative to it. Single source of truth: if
// npm reshuffles its global layout (-g vs --prefix vs corepack), Node still
// knows the right answer.
func resolveDaemonScript(nodePath string) (string, error) {
	cmd := exec.Command(nodePath, "-e", "console.log(require.resolve('@edihasaj/recall/package.json'))")
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	pkgJSON := stringTrim(string(out))
	if pkgJSON == "" {
		return "", errors.New("empty resolution from node require.resolve")
	}
	candidate := filepath.Join(filepath.Dir(pkgJSON), "dist", "daemon.js")
	if _, err := os.Stat(candidate); err != nil {
		return "", fmt.Errorf("stat %s: %w", candidate, err)
	}
	return candidate, nil
}

func stringTrim(s string) string {
	end := len(s)
	for end > 0 && (s[end-1] == '\n' || s[end-1] == '\r' || s[end-1] == ' ' || s[end-1] == '\t') {
		end--
	}
	return s[:end]
}

// Start spawns the daemon child if not already running. Idempotent.
func (m *Manager) Start(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cmd != nil && m.cmd.Process != nil {
		// Check it's actually alive.
		if err := m.cmd.Process.Signal(nil); err == nil {
			return nil
		}
		m.cmd = nil
	}
	if err := os.MkdirAll(filepath.Dir(m.LogPath), 0o755); err != nil {
		return err
	}
	logFile, err := os.OpenFile(m.LogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, m.NodePath, m.DaemonJS)
	cmd.Env = append(os.Environ(), fmt.Sprintf("RECALL_PORT=%d", m.Port))
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	hideConsoleWindow(cmd) // no flashing cmd.exe popup on Windows
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("spawn daemon: %w", err)
	}
	m.cmd = cmd
	go func() {
		_ = cmd.Wait()
		m.mu.Lock()
		m.cmd = nil
		m.healthy = false
		m.mu.Unlock()
		_ = logFile.Close()
	}()
	return nil
}

// Stop sends a graceful kill; falls back to hard kill after a short grace.
func (m *Manager) Stop() error {
	m.mu.Lock()
	cmd := m.cmd
	m.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	_ = cmd.Process.Kill()
	return nil
}

// Restart is Stop + Start with a small wait so the port releases.
func (m *Manager) Restart(ctx context.Context) error {
	if err := m.Stop(); err != nil {
		return err
	}
	time.Sleep(250 * time.Millisecond)
	return m.Start(ctx)
}

// Healthy reports the last probed health state. The Watch loop updates it.
func (m *Manager) Healthy() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.healthy
}

// LastError returns the most recent probe error for surfacing in the tray.
func (m *Manager) LastError() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lastErr
}

// DashboardURL is where the tray should send the user when they click
// "Open Dashboard". The recall daemon mounts the webui at /ui.
func (m *Manager) DashboardURL() string {
	return fmt.Sprintf("http://localhost:%d/ui", m.Port)
}

// HealthURL is the endpoint Watch polls.
func (m *Manager) HealthURL() string {
	return fmt.Sprintf("http://localhost:%d/health", m.Port)
}

// Watch polls /health every interval until ctx is done, updating Healthy().
// Calls onChange whenever the state flips so the tray can repaint its title.
func (m *Manager) Watch(ctx context.Context, interval time.Duration, onChange func(healthy bool)) {
	prev := m.Healthy()
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			ok, err := probeHealth(client, m.HealthURL())
			m.mu.Lock()
			m.healthy = ok
			m.lastErr = err
			m.mu.Unlock()
			if ok != prev && onChange != nil {
				onChange(ok)
				prev = ok
			}
		}
	}
}

func probeHealth(c *http.Client, url string) (bool, error) {
	resp, err := c.Get(url)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode == http.StatusOK, nil
}
