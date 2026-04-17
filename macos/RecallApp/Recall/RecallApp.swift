import AppKit
import SwiftUI

extension Notification.Name {
    static let recallOpenDashboard = Notification.Name("RecallOpenDashboard")
    static let recallRefreshStatus = Notification.Name("RecallRefreshStatus")
}

@main
struct RecallApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var controller = DaemonController()
    @StateObject private var preferences = AppPreferences()

    init() {
        AppPreferences.applyBundledAppIcon()
    }

    var body: some Scene {
        Window("Recall", id: "dashboard") {
            DashboardView(controller: controller, preferences: preferences)
                .frame(minWidth: 560, minHeight: 420)
                .task {
                    controller.start()
                    preferences.applyActivationPolicy()
                    delegate.attach(controller: controller)
                }
                .background(WindowOpener())
        }
        .defaultSize(width: 640, height: 460)

        Settings {
            SettingsView(preferences: preferences)
                .frame(width: 420)
        }
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

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem?
    private var templateImage: NSImage?
    private var colorImage: NSImage?
    private weak var controller: DaemonController?

    func applicationDidFinishLaunching(_ notification: Notification) {
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
        menu.addItem(makeItem(title: "Open Recall", action: #selector(openDashboard)))
        menu.addItem(makeItem(title: "Refresh Status", action: #selector(refreshStatus)))
        menu.addItem(NSMenuItem.separator())
        let settings = makeItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        menu.addItem(settings)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(makeItem(title: "Quit Recall", action: #selector(quit), keyEquivalent: "q"))
        item.menu = menu
    }

    func attach(controller: DaemonController) {
        self.controller = controller
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
    }

    func menuDidClose(_ menu: NSMenu) {
        if let template = templateImage {
            statusItem?.button?.image = template
        }
    }

    // MARK: Actions

    @objc private func openDashboard() {
        NSApp.activate(ignoringOtherApps: true)
        NotificationCenter.default.post(name: .recallOpenDashboard, object: nil)
    }

    @objc private func refreshStatus() {
        controller?.refresh()
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
        NSApp.terminate(nil)
    }
}

struct DashboardView: View {
    @ObservedObject var controller: DaemonController
    @ObservedObject var preferences: AppPreferences

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 16) {
                Image(nsImage: NSApplication.shared.applicationIconImage)
                    .resizable()
                    .interpolation(.high)
                    .frame(width: 72, height: 72)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                VStack(alignment: .leading, spacing: 6) {
                    Text("Recall")
                        .font(.system(size: 28, weight: .semibold))
                    Text(controller.summary)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                StatusBadge(healthy: controller.healthOK)
            }

            GroupBox("Daemon") {
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

            GroupBox("Appearance") {
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
                .padding(.top, 4)
            }

            if let lastError = controller.lastError, !lastError.isEmpty {
                Text(lastError)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.red)
            }

            if controller.setupRunning {
                HStack(spacing: 10) {
                    ProgressView()
                        .controlSize(.small)
                    Text(controller.setupStatus)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                }
            }

            HStack(spacing: 10) {
                Button("Install + Start") { controller.installAndStart() }
                Button("Start") { controller.startDaemon() }
                Button("Stop") { controller.stopDaemon() }
                Button("Restart") { controller.restartDaemon() }
            }

            HStack(spacing: 10) {
                Button("Open Data Folder") { controller.openDataDir() }
                Button("Open Logs") { controller.openLogDir() }
                Button("Refresh") { controller.refresh() }
            }

            Spacer()
        }
        .padding(20)
    }
}

private struct SettingsView: View {
    @ObservedObject var preferences: AppPreferences

    var body: some View {
        Form {
            Toggle("Show Dock Icon", isOn: Binding(
                get: { preferences.showDockIcon },
                set: { preferences.setShowDockIcon($0) }
            ))
            Text("Recall stays menu bar only by default. Turn this on only if you want Dock presence.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(20)
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

@MainActor
final class AppPreferences: ObservableObject {
    @Published private(set) var showDockIcon: Bool

    private let defaults = UserDefaults.standard
    private let dockKey = "showDockIcon"

    init() {
        self.showDockIcon = defaults.object(forKey: dockKey) as? Bool ?? false
        Self.applyBundledAppIcon()
        applyActivationPolicy()
    }

    func setShowDockIcon(_ enabled: Bool) {
        showDockIcon = enabled
        defaults.set(enabled, forKey: dockKey)
        applyActivationPolicy()
    }

    func applyActivationPolicy() {
        Self.applyBundledAppIcon()
        let policy: NSApplication.ActivationPolicy = showDockIcon ? .regular : .accessory
        NSApp.setActivationPolicy(policy)
        if showDockIcon {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    static func applyBundledAppIcon() {
        guard let path = Bundle.main.path(forResource: "AppIcon", ofType: "icns"),
              let image = NSImage(contentsOfFile: path) else { return }
        NSApplication.shared.applicationIconImage = image
    }
}
