//go:build !windows

package dashboard

import (
	"errors"
	"os/exec"
	"runtime"
)

func Open(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	case "linux":
		return exec.Command("xdg-open", url).Start()
	}
	return errors.New("dashboard: unsupported platform " + runtime.GOOS)
}
