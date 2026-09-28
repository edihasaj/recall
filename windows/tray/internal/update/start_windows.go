//go:build windows

package update

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

const createNewConsole = 0x00000010

// StartInstaller downloads the verified release installer to a stable location,
// then starts it in a separate console. The tray exits only after Start succeeds.
func StartInstaller(latestVersion, installerSHA256 string, trayPID int) error {
	if !IsNewer(latestVersion, "0.0.0") {
		return fmt.Errorf("invalid update version %q", latestVersion)
	}
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		return fmt.Errorf("LOCALAPPDATA is unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	script, err := DownloadInstaller(ctx, latestVersion, installerSHA256)
	if err != nil {
		return err
	}
	updateDir := filepath.Join(localAppData, "Recall", "updates")
	if err := os.MkdirAll(updateDir, 0o700); err != nil {
		return err
	}
	file, err := os.CreateTemp(updateDir, "install-*.ps1")
	if err != nil {
		return err
	}
	staged := file.Name()
	if _, err := file.Write(script); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	cmd := exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
		"-File", staged, "-Version", trimVersionPrefix(latestVersion), "-WaitForPid", strconv.Itoa(trayPID))
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewConsole}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start updater: %w", err)
	}
	return cmd.Process.Release()
}
