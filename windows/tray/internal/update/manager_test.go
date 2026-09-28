package update

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestVersionComparison(t *testing.T) {
	for _, tc := range []struct {
		latest, current string
		want            bool
	}{
		{"1.4.18", "v1.4.17", true},
		{"1.4.9", "1.4.17", false},
		{"1.4.17", "v1.4.17", false},
		{"1.4.18-beta.1", "1.4.17", false},
	} {
		if got := IsNewer(tc.latest, tc.current); got != tc.want {
			t.Errorf("IsNewer(%q, %q) = %v, want %v", tc.latest, tc.current, got, tc.want)
		}
	}
}

func TestRefreshReadsDaemonReleaseCheck(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/update" || r.URL.Query().Get("refresh") != "1" {
			t.Errorf("unexpected update request: %s", r.URL.String())
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"current_version":"1.4.17","latest_version":"1.4.18","available":true,"ready":true}`))
	}))
	defer srv.Close()
	m := New(srv.URL)
	report, err := m.Refresh(context.Background(), true)
	if err != nil || !report.Ready || !IsNewer(report.LatestVersion, "v1.4.17") {
		t.Fatalf("refresh: report=%+v err=%v", report, err)
	}
	if cached, ok := m.Status(); !ok || cached.LatestVersion != report.LatestVersion {
		t.Fatalf("cached update mismatch: %+v, %v", cached, ok)
	}
}

func TestInstallerPathUsesInstalledPackage(t *testing.T) {
	got := InstallerPath(filepath.Join("npm", "node_modules", "@edihasaj", "recall", "dist", "daemon.js"))
	want := filepath.Join("npm", "node_modules", "@edihasaj", "recall", "scripts", "install.ps1")
	if got != want {
		t.Fatalf("installer path = %q, want %q", got, want)
	}
}
