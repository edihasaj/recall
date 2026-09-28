package update

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Report is the daemon's cached release check.
type Report struct {
	CurrentVersion string `json:"current_version"`
	LatestVersion  string `json:"latest_version"`
	Available      bool   `json:"available"`
	Ready          bool   `json:"ready"`
	ReleaseURL     string `json:"release_url"`
	Error          string `json:"error"`
}

type Manager struct {
	baseURL string
	client  *http.Client
	mu      sync.Mutex
	last    Report
	lastOK  bool
}

func New(baseURL string) *Manager {
	return &Manager{
		baseURL: strings.TrimRight(baseURL, "/"),
		client:  &http.Client{Timeout: 12 * time.Second},
	}
}

func (m *Manager) Status() (Report, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.last, m.lastOK
}

func (m *Manager) Refresh(ctx context.Context, force bool) (Report, error) {
	path := "/update"
	if force {
		path += "?refresh=1"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.baseURL+path, nil)
	if err != nil {
		return Report{}, err
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return Report{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Report{}, fmt.Errorf("update check: http %d", resp.StatusCode)
	}
	var report Report
	if err := json.NewDecoder(resp.Body).Decode(&report); err != nil {
		return Report{}, err
	}
	if report.Error != "" {
		return report, fmt.Errorf("update check: %s", report.Error)
	}
	m.mu.Lock()
	m.last, m.lastOK = report, true
	m.mu.Unlock()
	return report, nil
}

func (m *Manager) Watch(ctx context.Context, interval time.Duration, onChange func(Report, bool)) {
	refresh := func() {
		report, err := m.Refresh(ctx, false)
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

func IsNewer(latest, current string) bool {
	parse := func(value string) ([]int, bool) {
		parts := strings.Split(strings.TrimPrefix(value, "v"), ".")
		if len(parts) != 3 {
			return nil, false
		}
		result := make([]int, 3)
		for i, part := range parts {
			if part == "" || strings.Trim(part, "0123456789") != "" {
				return nil, false
			}
			number, err := strconv.Atoi(part)
			if err != nil {
				return nil, false
			}
			result[i] = number
		}
		return result, true
	}
	a, okA := parse(latest)
	b, okB := parse(current)
	if !okA || !okB {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return false
}

func InstallerPath(daemonScript string) string {
	return filepath.Join(filepath.Dir(filepath.Dir(daemonScript)), "scripts", "install.ps1")
}
