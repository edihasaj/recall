//go:build windows

package update

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

const createNewConsole = 0x00000010

// StartInstaller copies the packaged installer outside npm's replaceable tree,
// then starts it in a separate console. The tray exits only after Start succeeds.
func StartInstaller(daemonScript, latestVersion string, trayPID int) error {
	if !IsNewer(latestVersion, "0.0.0") {
		return fmt.Errorf("invalid update version %q", latestVersion)
	}
	latestVersion = strings.TrimPrefix(latestVersion, "v")
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		return fmt.Errorf("LOCALAPPDATA is unavailable")
	}
	script, err := os.ReadFile(InstallerPath(daemonScript))
	if err != nil {
		return fmt.Errorf("updater script unavailable: %w", err)
	}
	updateDir := filepath.Join(localAppData, "Recall", "updates")
	if err := os.MkdirAll(updateDir, 0o700); err != nil {
		return err
	}
	staged := filepath.Join(updateDir, fmt.Sprintf("install-%s-%d.ps1", latestVersion, trayPID))
	if err := os.WriteFile(staged, script, 0o600); err != nil {
		return err
	}
	cmd := exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
		"-File", staged, "-Version", latestVersion, "-WaitForPid", strconv.Itoa(trayPID))
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewConsole}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start updater: %w", err)
	}
	return cmd.Process.Release()
}
