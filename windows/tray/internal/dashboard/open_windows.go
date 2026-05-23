//go:build windows

package dashboard

import (
	"os/exec"
	"syscall"
)

// Open launches the default browser via rundll32 + url.dll. Avoids
// `cmd /c start` because spawning cmd.exe from a GUI-subsystem tray
// process allocates a console window that the user has to close.
// CREATE_NO_WINDOW + HideWindow keeps rundll32 itself invisible.
func Open(url string) error {
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
	return cmd.Start()
}
