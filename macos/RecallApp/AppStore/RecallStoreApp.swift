import AppKit
import Combine
import SwiftUI

@main
struct RecallStoreApp: App {
    @NSApplicationDelegateAdaptor(StoreAppDelegate.self) private var delegate
    var body: some Scene {
        Settings {
            SettingsView(preferences: delegate.preferences)
                .frame(width: 420)
        }
    }
}

@MainActor
final class StoreAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let runtime = StoreRuntime()
    let controller: DaemonController
    let webui: WebUIController
    let preferences: AppPreferences
    let updates = UpdateController()
    private var statusItem: NSStatusItem?
    private var observation: AnyCancellable?
    private(set) var window: NSWindow?

    override init() {
        // The store edition starts at login only when the person turns it on.
        UserDefaults.standard.register(defaults: ["launchAtLogin": false])
        controller = DaemonController(runtime: runtime)
        webui = WebUIController(daemon: controller)
        preferences = AppPreferences()
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
        runtime.start()
        webui.start()
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(named: "MenuBarIcon")
        item.button?.image?.isTemplate = true
        let menu = NSMenu()
        menu.addItem(withTitle: "Recall \(AppVersion.display)", action: nil, keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Open Recall", action: #selector(showRecall), keyEquivalent: "")
        menu.addItem(withTitle: "Preferences…", action: #selector(showPreferences), keyEquivalent: ",")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Recall", action: #selector(quitRecall), keyEquivalent: "q")
        for entry in menu.items where entry.action != nil { entry.target = self }
        item.menu = menu
        item.isVisible = preferences.showMenuBarIcon
        statusItem = item
        observation = preferences.$showMenuBarIcon.sink { [weak self] visible in
            self?.statusItem?.isVisible = visible
        }
        showRecall()
    }

    @objc func showRecall() {
        if window == nil {
            let host = NSHostingController(rootView: DashboardView(
                controller: controller,
                preferences: preferences,
                webui: webui,
                updates: updates,
                onInstallUpdate: {}
            ).frame(minWidth: 820, minHeight: 600))
            let created = NSWindow(contentViewController: host)
            created.title = "Recall"
            created.styleMask = [.titled, .closable, .miniaturizable, .resizable]
            created.setContentSize(NSSize(width: 920, height: 640))
            created.isReleasedWhenClosed = false
            created.delegate = self
            created.center()
            window = created
        }
        preferences.setDashboardVisible(true)
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    @objc private func showPreferences() {
        showRecall()
        NotificationCenter.default.post(name: .recallOpenPreferences, object: nil)
    }

    func windowWillClose(_ notification: Notification) {
        preferences.setDashboardVisible(false)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showRecall()
        return false
    }
    @objc private func quitRecall() { NSApp.terminate(nil) }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Task {
            await runtime.stop()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}
