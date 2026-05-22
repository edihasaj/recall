//go:build windows

package daemon

import (
	"os/exec"
	"syscall"
)

// hideConsoleWindow tells CreateProcess to skip allocating a console window
// so the spawned node.exe doesn't flash a cmd prompt on the user's screen.
func hideConsoleWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
}
