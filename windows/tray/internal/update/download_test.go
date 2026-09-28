package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestInstallerDownloadRequiresMatchingChecksum(t *testing.T) {
	script := []byte("Write-Host 'safe installer'")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(script)
	}))
	defer srv.Close()
	sum := sha256.Sum256(script)
	got, err := downloadAndVerify(context.Background(), srv.Client(), srv.URL, hex.EncodeToString(sum[:]))
	if err != nil || string(got) != string(script) {
		t.Fatalf("verified download = %q, %v", got, err)
	}
	if _, err := downloadAndVerify(context.Background(), srv.Client(), srv.URL, hex.EncodeToString(make([]byte, 32))); err == nil {
		t.Fatal("incorrect checksum accepted")
	}
}
