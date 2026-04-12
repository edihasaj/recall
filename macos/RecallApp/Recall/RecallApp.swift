import AppKit
import SwiftUI

@main
struct RecallApp: App {
    @StateObject private var controller = DaemonController()
    @StateObject private var preferences = AppPreferences()

    init() {
        AppPreferences.applyBundledAppIcon()
    }

    var body: some Scene {
        MenuBarExtra("Recall", image: "MenuBarIcon") {
            MenuContent(controller: controller, preferences: preferences)
        }

        Window("Recall", id: "dashboard") {
            DashboardView(controller: controller, preferences: preferences)
                .frame(minWidth: 560, minHeight: 420)
                .task {
                    controller.start()
                    preferences.applyActivationPolicy()
                }
        }
        .defaultSize(width: 640, height: 460)

        Settings {
            SettingsView(preferences: preferences)
                .frame(width: 420)
        }
    }
}

private struct MenuContent: View {
    @ObservedObject var controller: DaemonController
    @ObservedObject var preferences: AppPreferences
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Recall")
                .font(.headline)
            Text(controller.healthOK ? "Daemon running" : "Daemon needs attention")
                .font(.caption)
                .foregroundStyle(.secondary)

            Divider()

            Button("Open Recall") {
                openWindow(id: "dashboard")
                NSApp.activate(ignoringOtherApps: true)
            }

            Button("Refresh Status") {
                controller.refresh()
            }

            Divider()

            SettingsLink {
                Text("Settings")
            }

            Divider()

            Button("Quit Recall") {
                NSApp.terminate(nil)
            }
        }
        .padding(.vertical, 4)
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
