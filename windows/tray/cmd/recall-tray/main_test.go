package main

import "testing"

func TestVersionTitleShowsMismatchedRuntime(t *testing.T) {
	if got := versionTitle("v1.4.17", "1.4.18"); got != "Tray v1.4.17 · daemon v1.4.18" {
		t.Fatalf("mismatched version title = %q", got)
	}
	if got := versionTitle("v1.4.18", "1.4.18"); got != "Recall v1.4.18" {
		t.Fatalf("matching version title = %q", got)
	}
}
