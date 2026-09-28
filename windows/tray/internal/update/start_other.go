//go:build !windows

package update

import "fmt"

func StartInstaller(_, _ string, _ int) error {
	return fmt.Errorf("in-app updates require Windows")
}
