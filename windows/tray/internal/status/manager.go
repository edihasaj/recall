package status

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Agent mirrors the subset of the daemon doctor report needed by the tray.
type Agent struct {
	Agent              string `json:"agent"`
	Detected           bool   `json:"detected"`
	MCP                bool   `json:"mcp"`
	Hooks              bool   `json:"hooks"`
	Hookless           bool   `json:"hookless"`
	Rules              string `json:"rules"`
	ClaudeMD           string `json:"claude_md"`
	LegacyNotifyBridge bool   `json:"legacy_notify_bridge"`
}

type Upgrade struct {
	Available bool `json:"available"`
}

// Report is the local daemon status consumed by the Windows tray.
type Report struct {
	Version string  `json:"version"`
	DBPath  string  `json:"db_path"`
	Agents  []Agent `json:"agents"`
	Upgrade Upgrade `json:"upgrade"`
}

// Manager polls the daemon's local /doctor endpoint.
type Manager struct {
	BaseURL string
	client  *http.Client

	mu     sync.Mutex
	last   Report
	lastOK bool
}

func New(baseURL string) *Manager {
	return &Manager{
		BaseURL: strings.TrimRight(baseURL, "/"),
		client:  &http.Client{Timeout: 2 * time.Second},
	}
}

func (m *Manager) Status() (Report, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.last, m.lastOK
}

func (m *Manager) Refresh(ctx context.Context) (Report, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.BaseURL+"/doctor", nil)
	if err != nil {
		return Report{}, err
	}
	resp, err := m.client.Do(req)
	if err != nil {
		m.setUnavailable()
		return Report{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		m.setUnavailable()
		return Report{}, fmt.Errorf("doctor status: http %d", resp.StatusCode)
	}

	var report Report
	if err := json.NewDecoder(resp.Body).Decode(&report); err != nil {
		m.setUnavailable()
		return Report{}, err
	}
	m.mu.Lock()
	m.last = report
	m.lastOK = true
	m.mu.Unlock()
	return report, nil
}

func (m *Manager) setUnavailable() {
	m.mu.Lock()
	m.lastOK = false
	m.mu.Unlock()
}

// Watch refreshes immediately, then at the requested interval until ctx ends.
func (m *Manager) Watch(ctx context.Context, interval time.Duration, onChange func(Report, bool)) {
	refresh := func() {
		report, err := m.Refresh(ctx)
		if onChange != nil {
			onChange(report, err == nil)
		}
	}

	refresh()
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			refresh()
		}
	}
}

// SetupLabel reduces the detailed doctor report to a tray-friendly summary.
func (r Report) SetupLabel() string {
	detected := 0
	for _, agent := range r.Agents {
		if !agent.Detected {
			continue
		}
		detected++
		if !agentHealthy(agent) {
			return "action required"
		}
	}
	if r.Upgrade.Available {
		return "action required"
	}
	if detected == 0 {
		return "no agents detected"
	}
	return "ready"
}

// AgentsLabel shows detected agent wiring without making the tray menu noisy.
func (r Report) AgentsLabel() string {
	labels := make([]string, 0, len(r.Agents))
	for _, agent := range r.Agents {
		if !agent.Detected {
			continue
		}
		marker := "!"
		if agentHealthy(agent) {
			marker = "✓"
		}
		labels = append(labels, agentDisplayName(agent.Agent)+" "+marker)
	}
	if len(labels) == 0 {
		return "none detected"
	}
	return strings.Join(labels, "  ")
}

func agentHealthy(agent Agent) bool {
	if !agent.MCP || agent.LegacyNotifyBridge {
		return false
	}
	if agent.Hookless {
		return agent.Rules == "current"
	}
	if !agent.Hooks {
		return false
	}
	if agent.Agent == "claude-code" && agent.ClaudeMD != "" && agent.ClaudeMD != "current" {
		return false
	}
	return true
}

func agentDisplayName(name string) string {
	switch name {
	case "claude-code":
		return "Claude"
	case "codex":
		return "Codex"
	case "github-copilot":
		return "Copilot"
	case "opencode":
		return "OpenCode"
	case "cursor":
		return "Cursor"
	case "windsurf":
		return "Windsurf"
	default:
		if name == "" {
			return "Unknown"
		}
		return strings.ToUpper(name[:1]) + name[1:]
	}
}
