import AppKit
import SwiftUI

@main
struct RecallStoreApp: App {
    @NSApplicationDelegateAdaptor(StoreAppDelegate.self) private var delegate
    var body: some Scene {
        Settings {
            StorePreferences(runtime: delegate.runtime).frame(width: 520, height: 400)
        }
    }
}

@MainActor
final class StoreAppDelegate: NSObject, NSApplicationDelegate {
    let runtime = StoreRuntime()
    private var statusItem: NSStatusItem?
    private(set) var window: NSWindow?
    func applicationDidFinishLaunching(_ notification: Notification) {
        guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
        runtime.start()
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(named: "MenuBarIcon")
        item.button?.image?.isTemplate = true
        let menu = NSMenu()
        menu.addItem(withTitle: "Open Recall", action: #selector(showRecall), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Recall", action: #selector(quitRecall), keyEquivalent: "q")
        for entry in menu.items { entry.target = self }
        item.menu = menu
        statusItem = item
        showRecall()
    }
    @objc func showRecall() {
        if window == nil {
            let host = NSHostingController(rootView: StoreDashboard(runtime: runtime))
            let created = NSWindow(contentViewController: host)
            created.title = "Recall"
            created.styleMask = [.titled, .closable, .miniaturizable, .resizable]
            created.setContentSize(NSSize(width: 1100, height: 760))
            created.minSize = NSSize(width: 980, height: 680)
            created.isReleasedWhenClosed = false
            created.center()
            window = created
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
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
