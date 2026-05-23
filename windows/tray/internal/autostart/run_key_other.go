//go:build !windows

package autostart

import "errors"

var errNonWindows = errors.New("autostart: only supported on windows")

func enabled() (bool, error)       { return false, nil }
func writeRunKey(exe string) error { return errNonWindows }
func deleteRunKey() error          { return errNonWindows }
