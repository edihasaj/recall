package daemon

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDaemonScriptAtGlobalRoot(t *testing.T) {
	got := daemonScriptAtGlobalRoot(filepath.Join("npm", "node_modules"))
	want := filepath.Join("npm", "node_modules", "@edihasaj", "recall", "dist", "daemon.js")
	if got != want {
		t.Fatalf("daemonScriptAtGlobalRoot() = %q, want %q", got, want)
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
