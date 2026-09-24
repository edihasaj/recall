package status

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func doctorServer(t *testing.T, report Report) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/doctor" || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(report); err != nil {
			t.Fatalf("encode doctor report: %v", err)
		}
	}))
}

func TestRefreshReadsDoctorReport(t *testing.T) {
	report := Report{
		Version: "1.4.14",
		DBPath:  `C:\\Users\\test\\.recall\\recall.db`,
		Agents: []Agent{
			{Agent: "codex", Detected: true, MCP: true, Hooks: true},
			{Agent: "claude-code", Detected: true, MCP: true, Hooks: true, ClaudeMD: "current"},
		},
	}
	srv := doctorServer(t, report)
	defer srv.Close()

	m := New(srv.URL)
	got, err := m.Refresh(context.Background())
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if got.Version != "1.4.14" || got.DBPath != report.DBPath {
		t.Fatalf("unexpected report: %+v", got)
	}
	if got.SetupLabel() != "ready" {
		t.Fatalf("setup = %q, want ready", got.SetupLabel())
	}
	if got.AgentsLabel() != "Codex ✓  Claude ✓" {
		t.Fatalf("agents = %q", got.AgentsLabel())
	}

	cached, ok := m.Status()
	if !ok || cached.Version != got.Version {
		t.Fatalf("cached report mismatch: ok=%v report=%+v", ok, cached)
	}
}

func TestSetupLabelDetectsMissingWiring(t *testing.T) {
	report := Report{
		Agents: []Agent{
			{Agent: "codex", Detected: true, MCP: true, Hooks: false},
		},
	}
	if report.SetupLabel() != "action required" {
		t.Fatalf("setup = %q, want action required", report.SetupLabel())
	}
	if report.AgentsLabel() != "Codex !" {
		t.Fatalf("agents = %q", report.AgentsLabel())
	}
}

func TestClaudeMemoryOverrideAffectsSetup(t *testing.T) {
	report := Report{
		Agents: []Agent{
			{
				Agent: "claude-code", Detected: true, MCP: true, Hooks: true,
				ClaudeMD: "stale",
			},
		},
	}
	if report.SetupLabel() != "action required" {
		t.Fatalf("setup = %q, want action required", report.SetupLabel())
	}
}

func TestHooklessAgentRequiresCurrentRules(t *testing.T) {
	report := Report{
		Agents: []Agent{
			{Agent: "cursor", Detected: true, MCP: true, Hookless: true, Rules: "current"},
		},
	}
	if report.SetupLabel() != "ready" {
		t.Fatalf("setup = %q, want ready", report.SetupLabel())
	}

	report.Agents[0].Rules = "stale"
	if report.SetupLabel() != "action required" {
		t.Fatalf("setup = %q, want action required", report.SetupLabel())
	}
}

func TestNoAgentsIsInformational(t *testing.T) {
	report := Report{}
	if report.SetupLabel() != "no agents detected" {
		t.Fatalf("setup = %q", report.SetupLabel())
	}
	if report.AgentsLabel() != "none detected" {
		t.Fatalf("agents = %q", report.AgentsLabel())
	}
}
