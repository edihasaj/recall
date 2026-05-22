// Package dashboard opens the user's default browser to the recall webui.
// Uses the well-known `cmd /c start "" <url>` incantation on Windows so
// quoted URLs survive shell parsing and the empty-title arg suppresses
// the "weird title" footgun of `start`.
package dashboard

import (
	"errors"
	"os/exec"
	"runtime"
)

// Open hands the URL to the platform default browser. Errors flow back to
// the tray so it can paint a "couldn't open" tooltip.
func Open(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("cmd", "/c", "start", "", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	case "linux":
		return exec.Command("xdg-open", url).Start()
	}
	return errors.New("dashboard: unsupported platform " + runtime.GOOS)
}
