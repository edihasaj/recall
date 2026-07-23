import AppKit
import SwiftUI

extension Notification.Name {
    static let recallOpenDashboard = Notification.Name("RecallOpenDashboard")
    static let recallOpenPreferences = Notification.Name("RecallOpenPreferences")
    static let recallRefreshStatus = Notification.Name("RecallRefreshStatus")
}

enum AppVersion {
    static let display: String = {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        let build = info?["CFBundleVersion"] as? String
        if let build, build != short, !build.isEmpty {
            return "v\(short) (\(build))"
        }
        return "v\(short)"
    }()
}

enum AppLayout {
    static let horizontalPadding: CGFloat = 20
    static let titlebarTopPadding: CGFloat = 32
    static let bottomPadding: CGFloat = 20
}

@main
struct RecallApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    init() {
        AppPreferences.applyBundledAppIcon()
    }

    var body: some Scene {
        Window("Recall", id: "dashboard") {
            DashboardHost(delegate: delegate)
                .frame(minWidth: 820, minHeight: 600)
                .background(WindowOpener())
                .background(DashboardWindowGuard())
        }
        .defaultSize(width: 920, height: 640)

        Settings {
            SettingsHost(delegate: delegate)
                .frame(width: 420)
        }
    }
}

/// Bridges the AppDelegate-owned controllers into the SwiftUI view tree.
/// Controllers live on AppDelegate so they exist from launch even though
/// LSUIElement keeps the Window scene from auto-materializing.
private struct DashboardHost: View {
    let delegate: AppDelegate

    var body: some View {
        DashboardView(
            controller: delegate.controller,
            preferences: delegate.preferences,
            webui: delegate.webui
        )
    }
}

private struct SettingsHost: View {
    let delegate: AppDelegate

    var body: some View {
        SettingsView(preferences: delegate.preferences)
    }
}

private struct WindowOpener: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .onReceive(NotificationCenter.default.publisher(for: .recallOpenDashboard)) { _ in
                openWindow(id: "dashboard")
                NSApp.activate(ignoringOtherApps: true)
            }
    }
}

private struct DashboardWindowGuard: NSViewRepresentable {
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        DispatchQueue.main.async {
            context.coordinator.attach(to: view.window)
        }
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        DispatchQueue.main.async {
            context.coordinator.attach(to: view.window)
        }
    }

    @MainActor
    final class Coordinator: NSObject, NSWindowDelegate {
        private weak var window: NSWindow?
        private var observesOpenDashboard = false

        func attach(to window: NSWindow?) {
            guard let window, self.window !== window else { return }
            self.window = window
            window.isReleasedWhenClosed = false
            window.delegate = self
            if !observesOpenDashboard {
                NotificationCenter.default.addObserver(
                    self,
                    selector: #selector(showWindow),
                    name: .recallOpenDashboard,
                    object: nil
                )
                observesOpenDashboard = true
            }
        }

        @objc private func showWindow() {
            window?.makeKeyAndOrderFront(nil)
        }

        func windowShouldClose(_ sender: NSWindow) -> Bool {
            sender.orderOut(nil)
            return false
        }

        deinit {
            NotificationCenter.default.removeObserver(self)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem?
    private var templateImage: NSImage?
    private var colorImage: NSImage?
    // Owned, not weak: SwiftUI scenes are lazy under LSUIElement, so AppDelegate
    // is the only place these can live from launch onward. The menu reads from
    // them immediately; the dashboard views observe them when (or if) shown.
    let controller = DaemonController()
    let preferences = AppPreferences()
    let webui = WebUIController()

    private var launchdStatusItem: NSMenuItem?
    private var healthStatusItem: NSMenuItem?
    private var setupStatusItem: NSMenuItem?
    private var dataStatusItem: NSMenuItem?
    private var loginStatusItem: NSMenuItem?
    private var webuiStatusItem: NSMenuItem?
    private var webuiToggleItem: NSMenuItem?
    private var userInitiatedQuit = false

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Menu bar is the persistent surface. Closing the dashboard window should
        // leave the status item + daemon bridge alive regardless of the dock
        // icon preference; quit only happens via the menu's "Quit Recall" item.
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // SwiftUI's Settings scene (and AppKit in some accessory-app paths)
        // calls NSApp.terminate when its window closes, bypassing
        // applicationShouldTerminateAfterLastWindowClosed. Cancel here unless
        // the user explicitly clicked "Quit Recall" from the menu bar.
        return userInitiatedQuit ? .terminateNow : .terminateCancel
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // Clicking the dock icon (when visible) or re-activating from Launchpad
        // after the window was closed should reopen the dashboard.
        if !flag {
            NotificationCenter.default.post(name: .recallOpenDashboard, object: nil)
        }
        return true
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Boot controllers first — the menu we're about to build reads from them.
        controller.start()
        webui.start()
        preferences.syncLaunchAtLogin()
        preferences.applyActivationPolicy()

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem = item

        if let image = NSImage(named: "MenuBarIcon") {
            image.isTemplate = true
            templateImage = image
            item.button?.image = image
        }
        colorImage = buildColorMenuBarImage()

        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false

        let header = NSMenuItem()
        header.title = "Recall \(AppVersion.display)"
        header.isEnabled = false
        menu.addItem(header)

        launchdStatusItem = makeStatusItem()
        healthStatusItem = makeStatusItem()
        setupStatusItem = makeStatusItem()
        dataStatusItem = makeStatusItem()
        loginStatusItem = makeStatusItem()
        webuiStatusItem = makeStatusItem()
        menu.addItem(launchdStatusItem!)
        menu.addItem(healthStatusItem!)
        menu.addItem(setupStatusItem!)
        menu.addItem(dataStatusItem!)
        menu.addItem(loginStatusItem!)
        menu.addItem(webuiStatusItem!)

        menu.addItem(NSMenuItem.separator())
        menu.addItem(makeItem(title: "Open Recall", action: #selector(openDashboard)))
        menu.addItem(makeItem(title: "Recall Cloud…", action: #selector(openCloud)))
        webuiToggleItem = makeItem(title: "Open Dashboard in Browser", action: #selector(toggleWebUi))
        menu.addItem(webuiToggleItem!)
        menu.addItem(makeItem(title: "Refresh Status", action: #selector(refreshStatus)))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(makeItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ","))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(makeItem(title: "Quit Recall", action: #selector(quit), keyEquivalent: "q"))
        item.menu = menu
    }

    private func makeStatusItem() -> NSMenuItem {
        let item = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func updateStatusItems() {
        launchdStatusItem?.title = "Launchd:  \(controller.launchdState)"
        let healthDot = controller.healthOK ? "●" : "○"
        healthStatusItem?.title = "Health:   \(healthDot) \(controller.healthText)"
        setupStatusItem?.title = "Setup:    \(controller.setupStatus)"
        dataStatusItem?.title = "Data:     \(controller.dataDir)"
        loginStatusItem?.title = "Login:    \(preferences.loginItemStatusText)"

        let dot = webui.running ? "●" : "○"
        webuiStatusItem?.title = "WebUI:    \(dot) \(webui.statusText)"
        webuiToggleItem?.title = webui.running
            ? "Close Dashboard (\(webui.clientCount) live)"
            : "Open Dashboard in Browser"
    }

    private func makeItem(title: String, action: Selector, keyEquivalent: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: keyEquivalent)
        item.target = self
        return item
    }

    private func buildColorMenuBarImage() -> NSImage? {
        guard let path = Bundle.main.path(forResource: "AppIcon", ofType: "icns"),
              let src = NSImage(contentsOfFile: path) else { return nil }
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size)
        image.lockFocus()
        src.draw(
            in: NSRect(origin: .zero, size: size),
            from: NSRect(origin: .zero, size: src.size),
            operation: .sourceOver,
            fraction: 1.0
        )
        image.unlockFocus()
        image.isTemplate = false
        return image
    }

    // MARK: NSMenuDelegate

    func menuWillOpen(_ menu: NSMenu) {
        if let color = colorImage {
            statusItem?.button?.image = color
        }
        preferences.refreshLoginItemStatus()
        controller.refresh()
        webui.refresh()
        updateStatusItems()
    }

    func menuDidClose(_ menu: NSMenu) {
        if let template = templateImage {
            statusItem?.button?.image = template
        }
    }

    // MARK: Actions

    @objc private func openDashboard() {
        NSApp.activate(ignoringOtherApps: true)
        // Fast path: window already materialized (WindowOpener observer is live).
        if NSApp.windows.contains(where: { $0.identifier?.rawValue.contains("dashboard") == true || $0.title == "Recall" }) {
            NotificationCenter.default.post(name: .recallOpenDashboard, object: nil)
            return
        }
        // Cold path: under LSUIElement the SwiftUI Window scene is lazy and has
        // never been instantiated. The Window menu item SwiftUI registers for
        // each Window scene is how we trigger first-time creation.
        if let item = swiftUIWindowMenuItem(named: "Recall") {
            NSApp.sendAction(item.action!, to: item.target, from: item)
            return
        }
        // Last resort — post the notification (becomes effective once the scene
        // materializes via some other path).
        NotificationCenter.default.post(name: .recallOpenDashboard, object: nil)
    }

    private func swiftUIWindowMenuItem(named title: String) -> NSMenuItem? {
        guard let windowMenu = NSApp.windowsMenu else { return nil }
        for item in windowMenu.items where item.title == title && item.action != nil {
            return item
        }
        return nil
    }

    @objc private func refreshStatus() {
        controller.refresh()
        webui.refresh()
        updateStatusItems()
    }

    @objc private func toggleWebUi() {
        if webui.running {
            webui.closeDashboard()
        } else {
            webui.openDashboard()
        }
    }

    @objc private func openSettings() {
        openDashboard()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            NotificationCenter.default.post(name: .recallOpenPreferences, object: nil)
        }
    }

    @objc private func openCloud() {
        guard let url = URL(string: "https://app.recallmemory.dev") else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func quit() {
        userInitiatedQuit = true
        NSApp.terminate(nil)
    }
}
