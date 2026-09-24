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
	traystatus "github.com/edihasaj/recall/windows/tray/internal/status"
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
	status       *traystatus.Manager
	mVersion     *systray.MenuItem
	mStatus      *systray.MenuItem
	mSetup       *systray.MenuItem
	mAgents      *systray.MenuItem
	mData        *systray.MenuItem
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

	s.mVersion = systray.AddMenuItem("Recall "+version, "Installed Recall tray version")
	s.mVersion.Disable()
	s.mStatus = systray.AddMenuItem("Daemon: starting…", "Daemon health")
	s.mStatus.Disable()
	s.mSetup = systray.AddMenuItem("Setup: checking…", "Agent integration status")
	s.mSetup.Disable()
	s.mAgents = systray.AddMenuItem("Agents: checking…", "Detected agent integrations")
	s.mAgents.Disable()
	s.mData = systray.AddMenuItem("Data: checking…", "Recall data directory")
	s.mData.Disable()
	s.mWebUI = systray.AddMenuItem("WebUI: …", "Web UI server state")
	s.mWebUI.Disable()
	systray.AddSeparator()
	mOpen := systray.AddMenuItem("Open Dashboard", "Open the Recall web UI in your browser")
	mCloud := systray.AddMenuItem("Recall Cloud…", "Open Recall Cloud in your browser")
	s.mWebUIToggle = systray.AddMenuItem("Start Dashboard", "Start the local web UI server")
	mRefresh := systray.AddMenuItem("Refresh Status", "Refresh daemon, setup, and WebUI status")
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
		baseURL := fmt.Sprintf("http://localhost:%d", s.mgr.Port)
		// Webui and setup state track the same local daemon.
		s.webui = webui.New(baseURL)
		go s.webui.Watch(ctx, 3*time.Second, repaintWebUI)
		s.status = traystatus.New(baseURL)
		go s.status.Watch(ctx, 10*time.Second, repaintDoctor)
	}

	mOpen.Click(func() {
		if s.mgr == nil || s.webui == nil {
			return
		}
		// Daemon at :7890 doesn't serve the SPA; the webui sub-server
		// at :7891 does. Ensure it's running, then open its URL.
		st, _ := s.webui.Status()
		if !st.Running {
			started, err := s.webui.Start(ctx)
			if err != nil {
				log.Printf("webui start (for open) failed: %v", err)
				return
			}
			st = started
		}
		if st.URL == "" {
			log.Printf("webui started but URL is empty")
			return
		}
		if err := dashboard.Open(st.URL); err != nil {
			log.Printf("dashboard open failed: %v", err)
		}
	})
	mCloud.Click(func() {
		if err := dashboard.Open("https://app.recallmemory.dev"); err != nil {
			log.Printf("recall cloud open failed: %v", err)
		}
	})
	mRefresh.Click(func() { refreshStatus(ctx) })
	mRestart.Click(func() {
		if s.mgr == nil {
			return
		}
		if err := s.mgr.Restart(ctx); err != nil {
			log.Printf("daemon restart failed: %v", err)
			return
		}
		refreshStatus(ctx)
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
		s.mStatus.SetTitle("Daemon: ● healthy")
	} else {
		systray.SetTooltip("Recall — daemon down")
		s.mStatus.SetTitle("Daemon: ○ not responding")
	}
}

func repaintDoctor(report traystatus.Report, ok bool) {
	if !ok {
		s.mSetup.SetTitle("Setup: ?")
		s.mAgents.SetTitle("Agents: ?")
		s.mData.SetTitle("Data: ?")
		return
	}
	if report.Version != "" {
		s.mVersion.SetTitle("Recall v" + report.Version)
	}
	s.mSetup.SetTitle("Setup: " + report.SetupLabel())
	s.mAgents.SetTitle("Agents: " + report.AgentsLabel())
	if report.DBPath == "" {
		s.mData.SetTitle("Data: unknown")
	} else {
		s.mData.SetTitle("Data: " + filepath.Dir(report.DBPath))
	}
}

func refreshStatus(ctx context.Context) {
	if s.status != nil {
		report, err := s.status.Refresh(ctx)
		repaintDoctor(report, err == nil)
		if err != nil {
			log.Printf("doctor status refresh failed: %v", err)
		}
	}
	if s.webui != nil {
		st, err := s.webui.Refresh(ctx)
		repaintWebUI(st, err == nil)
		if err != nil {
			log.Printf("webui status refresh failed: %v", err)
		}
	}
	if s.mgr != nil {
		repaintHealth(s.mgr.Healthy())
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
