// Package autostart toggles a per-user Windows Run-key entry so the tray
// app launches at login. HKCU\Software\Microsoft\Windows\CurrentVersion\Run
// is the standard mechanism — no admin needed, no service plumbing, instant.
package autostart

import (
	"fmt"
	"os"
	"strings"
)

// runKeyPath is the per-user registry path Windows runs at logon.
const runKeyPath = `Software\Microsoft\Windows\CurrentVersion\Run`

// ValueName is the registry value name we own. Stable so toggling on/off
// twice doesn't leave orphaned entries.
const ValueName = "RecallTray"

// Enabled reports whether our entry is present (and points at us).
func Enabled() (bool, error) { return enabled() }

// Enable writes a Run-key entry pointing at the current executable. The
// path is wrapped in quotes so spaces in "C:\Program Files\..." work.
func Enable() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate self exe: %w", err)
	}
	return writeRunKey(exe)
}

// Disable removes our entry. No-op if it was never set.
func Disable() error { return deleteRunKey() }

// quoteExe wraps exe in double quotes if not already.
func quoteExe(exe string) string {
	exe = strings.TrimSpace(exe)
	if strings.HasPrefix(exe, `"`) && strings.HasSuffix(exe, `"`) {
		return exe
	}
	return `"` + exe + `"`
}
