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
	"log"
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

	mu        sync.Mutex
	cmd       *exec.Cmd
	healthy   bool
	lastErr   error
	done      chan struct{}
	wanted    bool
	failures  int
	restartAt time.Time
}

// New returns a Manager with defaults filled in. Resolution order for the
// daemon script:
//  1. $RECALL_DAEMON_SCRIPT env var (escape hatch).
//  2. Resolved via `node -e "console.log(require.resolve('@edihasaj/recall/package.json'))"`,
//     then sibling dist/daemon.js.
//  3. Resolved from `npm root -g`.
//  4. Fall back to the per-user npm-global location on Windows.
//
// Step 2 keeps the tray honest about which install it's binding to.
func New() (*Manager, error) {
	m := &Manager{
		NodePath: "node",
		Port:     defaultPort,
		LogPath:  filepath.Join(os.Getenv("LOCALAPPDATA"), "Recall", "daemon.log"),
	}
	if env := os.Getenv("RECALL_NODE_PATH"); env != "" {
		m.NodePath = env
	}
	if env := os.Getenv("RECALL_DAEMON_SCRIPT"); env != "" {
		m.DaemonJS = env
		return m, nil
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
	if err == nil {
		pkgJSON := stringTrim(string(out))
		if pkgJSON != "" {
			candidate := filepath.Join(filepath.Dir(pkgJSON), "dist", "daemon.js")
			if _, statErr := os.Stat(candidate); statErr == nil {
				return candidate, nil
			}
		}
	}

	var candidates []string
	npmOut, npmErr := exec.Command("npm", "root", "-g").Output()
	if npmErr == nil {
		candidates = append(candidates, daemonScriptAtGlobalRoot(stringTrim(string(npmOut))))
	}
	if appData := os.Getenv("APPDATA"); appData != "" {
		candidates = append(candidates, daemonScriptAtGlobalRoot(filepath.Join(appData, "npm", "node_modules")))
	}

	if candidate, findErr := firstExistingFile(candidates); findErr == nil {
		return candidate, nil
	}
	if err != nil {
		return "", err
	}
	return "", errors.New("package resolved, but dist/daemon.js was not found")
}

func daemonScriptAtGlobalRoot(root string) string {
	return filepath.Join(root, "@edihasaj", "recall", "dist", "daemon.js")
}

func firstExistingFile(candidates []string) (string, error) {
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	return "", errors.New("no candidate exists")
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
	if err := ctx.Err(); err != nil {
		return err
	}
	m.wanted = true
	return m.startLocked(ctx)
}

// Wait owns process liveness. Signal(nil) is not a portable liveness probe
// on Windows and allowed duplicate daemon children to be spawned.
func (m *Manager) startLocked(ctx context.Context) error {
	if m.cmd != nil {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(m.LogPath), 0o755); err != nil {
		m.scheduleRetryLocked(err)
		return err
	}
	logFile, err := os.OpenFile(m.LogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		m.scheduleRetryLocked(err)
		return err
	}
	cmd := exec.CommandContext(ctx, m.NodePath, m.DaemonJS)
	cmd.Env = append(os.Environ(), fmt.Sprintf("RECALL_PORT=%d", m.Port))
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	hideConsoleWindow(cmd) // no flashing cmd.exe popup on Windows
	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		m.scheduleRetryLocked(err)
		return fmt.Errorf("spawn daemon: %w", err)
	}
	m.cmd = cmd
	done := make(chan struct{})
	m.done = done
	go func() {
		err := cmd.Wait()
		m.mu.Lock()
		if m.cmd == cmd {
			m.cmd = nil
			m.healthy = false
			if m.wanted && ctx.Err() == nil {
				if err == nil {
					err = errors.New("daemon exited unexpectedly")
				}
				m.scheduleRetryLocked(err)
			}
		}
		close(done)
		m.mu.Unlock()
		_ = logFile.Close()
	}()
	return nil
}

func (m *Manager) scheduleRetryLocked(err error) {
	m.failures++
	delay := time.Second
	for attempt := 1; attempt < m.failures && delay < 30*time.Second; attempt++ {
		delay *= 2
	}
	if delay > 30*time.Second {
		delay = 30 * time.Second
	}
	m.restartAt = time.Now().Add(delay)
	m.lastErr = err
	log.Printf("daemon stopped unexpectedly; retry in %s: %v", delay, err)
}

// Stop is intentional: disable recovery and wait for the owned child to exit.
func (m *Manager) Stop() error {
	m.mu.Lock()
	m.wanted = false
	cmd := m.cmd
	done := m.done
	m.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	select {
	case <-done:
		return nil
	case <-time.After(3 * time.Second):
		return errors.New("daemon did not exit after stop")
	}
}

// Restart waits for the old child before spawning a replacement.
func (m *Manager) Restart(ctx context.Context) error {
	if err := m.Stop(); err != nil {
		return err
	}
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
			if ctx.Err() != nil {
				return
			}
			m.mu.Lock()
			m.healthy = ok
			m.lastErr = err
			if ok {
				m.failures = 0
			}
			if !ok && m.wanted && m.cmd == nil && !time.Now().Before(m.restartAt) {
				if startErr := m.startLocked(ctx); startErr != nil {
					m.lastErr = startErr
				}
			}
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
