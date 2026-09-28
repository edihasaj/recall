package update

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const installerAsset = "Recall-Install.ps1"
const maxInstallerBytes = 256 * 1024

func trimVersionPrefix(version string) string { return strings.TrimPrefix(version, "v") }

// DownloadInstaller accepts only stable numeric versions and the checksum
// supplied by the release API. The download host and asset name are fixed.
func DownloadInstaller(ctx context.Context, version, expectedSHA256 string) ([]byte, error) {
	if !IsNewer(version, "0.0.0") {
		return nil, fmt.Errorf("invalid update version %q", version)
	}
	url := "https://github.com/edihasaj/recall/releases/download/v" + trimVersionPrefix(version) + "/" + installerAsset
	return downloadAndVerify(ctx, http.DefaultClient, url, expectedSHA256)
}

func downloadAndVerify(ctx context.Context, client *http.Client, url, expectedSHA256 string) ([]byte, error) {
	expected, err := hex.DecodeString(expectedSHA256)
	if err != nil || len(expected) != sha256.Size {
		return nil, fmt.Errorf("invalid installer checksum")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("installer download: http %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxInstallerBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxInstallerBytes {
		return nil, fmt.Errorf("installer exceeds size limit")
	}
	actual := sha256.Sum256(data)
	if subtle.ConstantTimeCompare(actual[:], expected) != 1 {
		return nil, fmt.Errorf("installer checksum mismatch")
	}
	return data, nil
}
