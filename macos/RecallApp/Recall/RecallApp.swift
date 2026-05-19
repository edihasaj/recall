import AppKit
import SwiftUI

extension Notification.Name {
    static let recallOpenDashboard = Notification.Name("RecallOpenDashboard")
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
        NSApp.activate(ignoringOtherApps: true)
        if #available(macOS 14, *) {
            NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
        } else {
            NSApp.sendAction(Selector(("showPreferencesWindow:")), to: nil, from: nil)
        }
    }

    @objc private func quit() {
        userInitiatedQuit = true
        NSApp.terminate(nil)
    }
}

struct DashboardView: View {
    @ObservedObject var controller: DaemonController
    @ObservedObject var preferences: AppPreferences
    @ObservedObject var webui: WebUIController

    @State private var selection: AppSection = .overview

    var body: some View {
        NavigationSplitView {
            SidebarView(
                selection: $selection,
                controller: controller,
                webui: webui
            )
            .navigationSplitViewColumnWidth(min: 220, ideal: 240, max: 280)
        } detail: {
            DetailView(
                section: selection,
                controller: controller,
                preferences: preferences,
                webui: webui
            )
        }
        .navigationSplitViewStyle(.balanced)
    }
}

private enum AppSection: String, Hashable, CaseIterable {
    case overview, daemon, webui, preferences

    var label: String {
        switch self {
        case .overview: return "Overview"
        case .daemon: return "Daemon"
        case .webui: return "Web Dashboard"
        case .preferences: return "Preferences"
        }
    }

    var systemImage: String {
        switch self {
        case .overview: return "square.grid.2x2.fill"
        case .daemon: return "bolt.horizontal.circle.fill"
        case .webui: return "safari.fill"
        case .preferences: return "gearshape.fill"
        }
    }
}

private struct SidebarView: View {
    @Binding var selection: AppSection
    @ObservedObject var controller: DaemonController
    @ObservedObject var webui: WebUIController

    var body: some View {
        VStack(spacing: 0) {
            // Brand + version
            HStack(spacing: 10) {
                Image(nsImage: NSApplication.shared.applicationIconImage)
                    .resizable()
                    .interpolation(.high)
                    .frame(width: 36, height: 36)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Recall")
                        .font(.system(size: 15, weight: .semibold))
                    Text(AppVersion.display)
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.top, 18)
            .padding(.bottom, 12)

            // Nav list
            List(selection: $selection) {
                Section {
                    ForEach(AppSection.allCases, id: \.self) { section in
                        Label(section.label, systemImage: section.systemImage)
                            .tag(section)
                    }
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)

            Divider()

            // Persistent footer — primary action always visible
            SidebarFooter(controller: controller, webui: webui)
                .padding(.horizontal, 12)
                .padding(.vertical, 12)
        }
    }
}

private struct SidebarFooter: View {
    @ObservedObject var controller: DaemonController
    @ObservedObject var webui: WebUIController

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Circle()
                    .fill(controller.healthOK ? Color.green : Color.orange)
                    .frame(width: 8, height: 8)
                Text(controller.healthOK ? "Daemon healthy" : "Needs attention")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                Spacer()
            }

            HStack(spacing: 8) {
                Circle()
                    .fill(webui.running ? Color.green : Color.gray.opacity(0.6))
                    .frame(width: 8, height: 8)
                Text(webui.running ? "WebUI live" : "WebUI offline")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                Spacer()
            }

            if webui.running {
                HStack(spacing: 6) {
                    Button {
                        webui.openInBrowser()
                    } label: {
                        Label("Open in Browser", systemImage: "safari")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)

                    Button {
                        webui.closeDashboard()
                    } label: {
                        Image(systemName: "xmark.circle")
                    }
                    .controlSize(.large)
                    .help("Close Dashboard")
                }
            } else {
                Button {
                    webui.openDashboard()
                } label: {
                    Label("Open Web Dashboard", systemImage: "safari")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
        }
    }
}

private struct DetailView: View {
    let section: AppSection
    @ObservedObject var controller: DaemonController
    @ObservedObject var preferences: AppPreferences
    @ObservedObject var webui: WebUIController

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            DetailHeader(section: section, controller: controller, webui: webui)
                .padding(.horizontal, 28)
                .padding(.top, 28)
                .padding(.bottom, 16)

            Divider()

            ScrollView(.vertical) {
                Group {
                    switch section {
                    case .overview:
                        OverviewTab(controller: controller, webui: webui)
                    case .daemon:
                        DaemonTab(controller: controller, webui: webui)
                    case .webui:
                        WebDashboardTab(webui: webui)
                    case .preferences:
                        PreferencesTab(preferences: preferences)
                    }
                }
                .padding(.horizontal, 28)
                .padding(.vertical, 20)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct DetailHeader: View {
    let section: AppSection
    @ObservedObject var controller: DaemonController
    @ObservedObject var webui: WebUIController

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(section.label)
                    .font(.system(size: 22, weight: .semibold))
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            StatusBadge(healthy: controller.healthOK)
        }
    }

    private var subtitle: String {
        switch section {
        case .overview:
            return "Snapshot of daemon and web dashboard state."
        case .daemon:
            return "Local HTTP daemon · lifecycle, paths, logs."
        case .webui:
            return "Browser-based dashboard on http://localhost:7891."
        case .preferences:
            return "Startup and appearance options."
        }
    }
}

private struct OverviewTab: View {
    @ObservedObject var controller: DaemonController
    @ObservedObject var webui: WebUIController

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 16) {
                GroupBox("Status") {
                    VStack(alignment: .leading, spacing: 10) {
                        LabeledValue(label: "Daemon", value: controller.launchdState)
                        LabeledValue(label: "Health", value: controller.healthText)
                        LabeledValue(label: "WebUI", value: webui.statusText)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
                }

                GroupBox("Quick Actions") {
                    HStack(spacing: 10) {
                        Button("Open Data Folder") { controller.openDataDir() }
                        Button("Open Logs") { controller.openLogDir() }
                        Spacer()
                        Button("Refresh") { controller.refresh(); webui.refresh() }
                    }
                    .padding(.top, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                if let lastError = controller.lastError, !lastError.isEmpty {
                    GroupBox("Recent Error") {
                        Text(lastError)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.top, 4)
                    }
                }

                if controller.setupRunning {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text(controller.setupStatus)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.horizontal, AppLayout.horizontalPadding)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }
}

private struct DaemonTab: View {
    @ObservedObject var controller: DaemonController
    @ObservedObject var webui: WebUIController

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 16) {
                GroupBox("Service") {
                    VStack(alignment: .leading, spacing: 10) {
                        LabeledValue(label: "Launchd", value: controller.launchdState)
                        LabeledValue(label: "Health", value: controller.healthText)
                        LabeledValue(label: "Setup", value: controller.setupStatus)
                        LabeledValue(label: "Data", value: controller.dataDir)
                        LabeledValue(label: "Logs", value: controller.logDir)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
                }

                GroupBox("Lifecycle") {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(spacing: 10) {
                            Button("Install + Start") { controller.installAndStart() }
                                .buttonStyle(.borderedProminent)
                            Button("Start") { controller.startDaemon() }
                            Button("Stop") { controller.stopDaemon() }
                            Button("Restart") { controller.restartDaemon() }
                        }
                        HStack(spacing: 10) {
                            Button("Open Data Folder") { controller.openDataDir() }
                            Button("Open Logs") { controller.openLogDir() }
                            Spacer()
                            Button("Refresh") { controller.refresh(); webui.refresh() }
                        }
                    }
                    .padding(.top, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                if let lastError = controller.lastError, !lastError.isEmpty {
                    Text(lastError)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.red)
                }
            }
            .padding(.horizontal, AppLayout.horizontalPadding)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }
}

private struct WebDashboardTab: View {
    @ObservedObject var webui: WebUIController

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 16) {
                GroupBox("Status") {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 10) {
                            Circle()
                                .fill(webui.running ? Color.green : Color.gray.opacity(0.5))
                                .frame(width: 10, height: 10)
                            Text(webui.statusText)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                        Text("The browser-based dashboard shows memories, the knowledge graph, contradictions, and live activity. It runs on http://localhost:7891 only while open and shuts itself down when you close it.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
                }

                GroupBox("Controls") {
                    HStack(spacing: 10) {
                        if webui.running {
                            Button {
                                webui.openInBrowser()
                            } label: {
                                Label("Open in Browser", systemImage: "safari")
                            }
                            .buttonStyle(.borderedProminent)
                            Button("Close Dashboard") { webui.closeDashboard() }
                        } else {
                            Button {
                                webui.openDashboard()
                            } label: {
                                Label("Open Web Dashboard", systemImage: "safari")
                            }
                            .buttonStyle(.borderedProminent)
                        }
                        Spacer()
                        Button("Refresh") { webui.refresh() }
                    }
                    .padding(.top, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                if let err = webui.lastError {
                    GroupBox("Last Error") {
                        Text(err)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.top, 4)
                    }
                }
            }
            .padding(.horizontal, AppLayout.horizontalPadding)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }
}

private struct PreferencesTab: View {
    @ObservedObject var preferences: AppPreferences

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 16) {
                GroupBox("Startup") {
                    VStack(alignment: .leading, spacing: 12) {
                        Toggle(isOn: Binding(
                            get: { preferences.launchAtLogin },
                            set: { preferences.setLaunchAtLogin($0) }
                        )) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Start at Login")
                                Text(preferences.loginItemStatusText)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .toggleStyle(.switch)
                    }
                    .padding(.top, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                GroupBox("Appearance") {
                    VStack(alignment: .leading, spacing: 12) {
                        Toggle(isOn: Binding(
                            get: { preferences.showDockIcon },
                            set: { preferences.setShowDockIcon($0) }
                        )) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Show Dock Icon")
                                Text("Off by default. Enable only when you want Recall in the Dock.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .toggleStyle(.switch)
                    }
                    .padding(.top, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, AppLayout.horizontalPadding)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }
}

private struct SettingsView: View {
    @ObservedObject var preferences: AppPreferences

    var body: some View {
        Form {
            Toggle("Start at Login", isOn: Binding(
                get: { preferences.launchAtLogin },
                set: { preferences.setLaunchAtLogin($0) }
            ))
            Text(preferences.loginItemStatusText)
                .font(.caption)
                .foregroundStyle(.secondary)

            Toggle("Show Dock Icon", isOn: Binding(
                get: { preferences.showDockIcon },
                set: { preferences.setShowDockIcon($0) }
            ))
            Text("Recall stays menu bar only by default. Turn this on only if you want Dock presence.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, AppLayout.horizontalPadding)
        .padding(.top, AppLayout.titlebarTopPadding)
        .padding(.bottom, AppLayout.bottomPadding)
    }
}

private struct StatusBadge: View {
    let healthy: Bool

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(healthy ? Color.green : Color.orange)
                .frame(width: 10, height: 10)
            Text(healthy ? "Running" : "Needs Attention")
                .font(.system(size: 12, weight: .semibold))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.quinary, in: Capsule())
    }
}

private struct LabeledValue: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text(label)
                .frame(width: 70, alignment: .leading)
                .foregroundStyle(.secondary)
            Text(value)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.system(size: 12, weight: .medium, design: .monospaced))
    }
}
