//go:build !windows

package daemon

import "os/exec"

// hideConsoleWindow is a noop on non-Windows: the build target is windows
// but we keep a stub so the package compiles for tests on Mac/Linux too.
func hideConsoleWindow(cmd *exec.Cmd) {}
