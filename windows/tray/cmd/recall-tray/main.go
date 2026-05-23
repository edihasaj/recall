// recall-tray is the Windows system-tray companion for the recall daemon.
// Role mirrors macos/RecallApp/Recall/RecallApp.swift: own a node-daemon
// child process, surface its health in the tray, give the user a one-click
// "open dashboard" entry, and optionally pin itself to the per-user
// Run-key so it lives across reboots.
package main

import (
	"context"
	_ "embed"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/energye/systray"

	"github.com/edihasaj/recall/windows/tray/internal/autostart"
	"github.com/edihasaj/recall/windows/tray/internal/daemon"
	"github.com/edihasaj/recall/windows/tray/internal/dashboard"
	"github.com/edihasaj/recall/windows/tray/internal/webui"
)

// Windows tray expects ICO bytes; PNG silently fails to register an HICON
// (systray returns "unable to set icon: The operation completed successfully"
// because LoadIconFromMemory rejects PNG headers). Ship a multi-resolution
// .ico (16/24/32/48/64/128/256) so the icon renders crisp at every DPI.
//
//go:embed icon.ico
var iconBytes []byte

var (
	version = "dev"
)

func main() {
	versionFlag := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *versionFlag {
		fmt.Println("recall-tray", version)
		return
	}

	// Logs land next to the daemon log so users have one folder to share.
	logDir := filepath.Join(os.Getenv("LOCALAPPDATA"), "Recall")
	_ = os.MkdirAll(logDir, 0o755)
	f, err := os.OpenFile(filepath.Join(logDir, "tray.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err == nil {
		log.SetOutput(f)
		defer f.Close()
	}
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Printf("recall-tray %s starting (pid=%d)", version, os.Getpid())

	systray.Run(onReady, onExit)
}

// state is the small bundle the tray needs to render itself and respond to
// menu clicks. Kept tight: the daemon supervisor + webui client + the menu
// items we mutate.
type state struct {
	mgr          *daemon.Manager
	webui        *webui.Manager
	mStatus      *systray.MenuItem
	mWebUI       *systray.MenuItem // disabled status row
	mWebUIToggle *systray.MenuItem // start/stop click target
	mAuto        *systray.MenuItem
	cancel       context.CancelFunc
}

var s state

func onReady() {
	systray.SetIcon(iconBytes)
	systray.SetTitle("Recall")
	systray.SetTooltip("Recall — starting…")

	mOpen := systray.AddMenuItem("Open Dashboard", "Open the Recall web UI in your browser")
	s.mStatus = systray.AddMenuItem("Status: starting…", "Daemon health")
	s.mStatus.Disable()
	s.mWebUI = systray.AddMenuItem("WebUI: …", "Web UI server state")
	s.mWebUI.Disable()
	s.mWebUIToggle = systray.AddMenuItem("Start Dashboard", "Start the local web UI server")
	systray.AddSeparator()
	mRestart := systray.AddMenuItem("Restart Daemon", "Stop and start the recall daemon child process")
	s.mAuto = systray.AddMenuItemCheckbox("Start at login", "Toggle the per-user Run-key entry", currentAutostart())
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("Quit Recall", "Stop the daemon and exit")

	mgr, err := daemon.New()
	if err != nil {
		log.Printf("daemon manager init failed: %v", err)
		systray.SetTooltip("Recall — install error: " + err.Error())
		s.mStatus.SetTitle("Install required (see tray.log)")
		// Still let the user open dashboard / quit; maybe daemon is running
		// from a previous install or another launcher.
	}
	s.mgr = mgr

	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel

	if s.mgr != nil {
		if err := s.mgr.Start(ctx); err != nil {
			log.Printf("daemon start failed: %v", err)
		}
		go s.mgr.Watch(ctx, 3*time.Second, repaintHealth)
		// Webui state tracks the same daemon process on the same port.
		s.webui = webui.New(fmt.Sprintf("http://localhost:%d", s.mgr.Port))
		go s.webui.Watch(ctx, 3*time.Second, repaintWebUI)
	}

	mOpen.Click(func() {
		if s.mgr == nil {
			return
		}
		if err := dashboard.Open(s.mgr.DashboardURL()); err != nil {
			log.Printf("dashboard open failed: %v", err)
		}
	})
	mRestart.Click(func() {
		if s.mgr == nil {
			return
		}
		if err := s.mgr.Restart(ctx); err != nil {
			log.Printf("daemon restart failed: %v", err)
		}
	})
	s.mWebUIToggle.Click(func() { toggleWebUI(ctx) })
	s.mAuto.Click(toggleAutostart)
	mQuit.Click(func() {
		log.Printf("quit requested")
		systray.Quit()
	})
}

func onExit() {
	log.Printf("recall-tray exiting")
	if s.cancel != nil {
		s.cancel()
	}
	if s.mgr != nil {
		_ = s.mgr.Stop()
	}
}

func repaintHealth(healthy bool) {
	if healthy {
		systray.SetTooltip("Recall — running on localhost:7890")
		s.mStatus.SetTitle("Status: healthy")
	} else {
		systray.SetTooltip("Recall — daemon down")
		s.mStatus.SetTitle("Status: not responding")
	}
}

// repaintWebUI mirrors macos/RecallApp/Recall/RecallApp.swift's webui menu:
// a dot + count for the status row, and a verb-flipping toggle. When the
// daemon is unreachable we show `WebUI: ?` and disable the toggle so users
// don't fire requests into the void.
func repaintWebUI(st webui.Status, ok bool) {
	if !ok {
		s.mWebUI.SetTitle("WebUI: ?")
		s.mWebUIToggle.SetTitle("Start Dashboard")
		s.mWebUIToggle.Disable()
		return
	}
	s.mWebUIToggle.Enable()
	if st.Running {
		if st.ClientCount > 0 {
			s.mWebUI.SetTitle(fmt.Sprintf("WebUI: ● running (%d live)", st.ClientCount))
		} else {
			s.mWebUI.SetTitle("WebUI: ● running")
		}
		s.mWebUIToggle.SetTitle("Stop Dashboard")
	} else {
		s.mWebUI.SetTitle("WebUI: ○ stopped")
		s.mWebUIToggle.SetTitle("Start Dashboard")
	}
}

func toggleWebUI(ctx context.Context) {
	if s.webui == nil {
		return
	}
	st, ok := s.webui.Status()
	if !ok {
		// Status unknown — refresh once before deciding direction so we
		// don't accidentally Start a webui that's actually running.
		st, _ = s.webui.Refresh(ctx)
	}
	if st.Running {
		if _, err := s.webui.Stop(ctx); err != nil {
			log.Printf("webui stop failed: %v", err)
			return
		}
		repaintWebUI(webui.Status{Running: false}, true)
		return
	}
	st2, err := s.webui.Start(ctx)
	if err != nil {
		log.Printf("webui start failed: %v", err)
		return
	}
	repaintWebUI(st2, true)
}

func currentAutostart() bool {
	on, err := autostart.Enabled()
	if err != nil {
		log.Printf("autostart probe failed: %v", err)
		return false
	}
	return on
}

func toggleAutostart() {
	if s.mAuto.Checked() {
		if err := autostart.Disable(); err != nil {
			log.Printf("autostart disable failed: %v", err)
			return
		}
		s.mAuto.Uncheck()
		return
	}
	if err := autostart.Enable(); err != nil {
		log.Printf("autostart enable failed: %v", err)
		return
	}
	s.mAuto.Check()
}
