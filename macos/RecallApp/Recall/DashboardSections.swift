import AppKit
import SwiftUI

struct OverviewTab: View {
    @ObservedObject var controller: DaemonController
    @ObservedObject var webui: WebUIController

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 18) {
                ZStack {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(Color.white.opacity(0.16))
                    Image(systemName: controller.healthOK ? "brain.head.profile.fill" : "waveform.path.ecg")
                        .font(.system(size: 30, weight: .semibold))
                        .foregroundStyle(.white)
                }
                .frame(width: 64, height: 64)

                VStack(alignment: .leading, spacing: 5) {
                    Text(controller.healthOK ? "Memory is ready" : "Recall needs attention")
                        .font(.system(size: 25, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                    Text(controller.healthOK
                         ? "Local-first, private by default, available to every connected agent."
                         : controller.healthText)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.white.opacity(0.82))
                }
                Spacer()
            }
            .padding(22)
            .background(
                LinearGradient(
                    colors: [Color(red: 0.10, green: 0.52, blue: 0.46), Color(red: 0.08, green: 0.31, blue: 0.33)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ),
                in: RoundedRectangle(cornerRadius: 22, style: .continuous)
            )

            HStack(spacing: 12) {
                StatusTile(
                    title: "Daemon",
                    value: controller.launchdState,
                    systemImage: "bolt.fill",
                    active: controller.healthOK
                )
                StatusTile(
                    title: "Cloud sync",
                    value: CloudConnection.isInstalled ? "Connected" : "Not connected",
                    systemImage: "cloud.fill",
                    active: CloudConnection.isInstalled
                )
                StatusTile(
                    title: "Dashboard",
                    value: webui.running ? "Live" : "Ready",
                    systemImage: "rectangle.3.group.fill",
                    active: webui.running
                )
            }

            HStack(spacing: 10) {
                Button {
                    webui.openDashboard()
                } label: {
                    Label("Open Memory Dashboard", systemImage: "safari")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                Button("Data Folder") { controller.openDataDir() }
                    .controlSize(.large)
                Button("Logs") { controller.openLogDir() }
                    .controlSize(.large)
                Spacer()
                Button {
                    controller.refresh()
                    webui.refresh()
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .controlSize(.large)
            }

            if let lastError = controller.lastError, !lastError.isEmpty {
                InlineNotice(text: lastError, systemImage: "exclamationmark.triangle.fill", color: .red)
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
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
}

struct CloudTab: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 18) {
                Image(systemName: "cloud.fill")
                    .font(.system(size: 32, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 58, height: 58)
                    .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 16))
                VStack(alignment: .leading, spacing: 6) {
                    Text(CloudConnection.isInstalled ? "This Mac is connected" : "Take Recall everywhere")
                        .font(.system(size: 23, weight: .bold, design: .rounded))
                    Text(CloudConnection.isInstalled
                         ? "Automatic two-way sync runs in the background. Your connected Macs and hosted agents share one consolidated memory."
                         : "Sign in once, connect this Mac, and Recall keeps every device and hosted agent in sync automatically.")
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
            }
            .padding(22)
            .background(.quaternary.opacity(0.55), in: RoundedRectangle(cornerRadius: 20, style: .continuous))

            HStack(spacing: 10) {
                Button {
                    CloudConnection.openConnect()
                } label: {
                    Label(
                        CloudConnection.isInstalled ? "Manage Cloud" : "Sign In & Connect",
                        systemImage: "arrow.up.right.square"
                    )
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

                Button {
                    CloudConnection.openMemories()
                } label: {
                    Label("Cloud Memories", systemImage: "brain.head.profile")
                }
                .controlSize(.large)
            }

            VStack(alignment: .leading, spacing: 12) {
                CloudFeatureRow(
                    icon: "arrow.triangle.2.circlepath",
                    title: "Automatic two-way sync",
                    detail: "Changes and tombstones converge every five minutes—no manual push or pull."
                )
                CloudFeatureRow(
                    icon: "network",
                    title: "Hosted MCP",
                    detail: "Codex, Claude, Cursor, and web agents can query the same synced memory."
                )
                CloudFeatureRow(
                    icon: "lock.shield.fill",
                    title: "You choose what leaves this Mac",
                    detail: "Local-only memories stay local; synced and end-to-end encrypted modes remain explicit."
                )
            }
            .padding(18)
            .background(.background, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(Color(nsColor: .separatorColor).opacity(0.45), lineWidth: 1)
            )
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
}

struct DaemonTab: View {
    @ObservedObject var controller: DaemonController
    @ObservedObject var webui: WebUIController

    var body: some View {
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
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
}

struct WebDashboardTab: View {
    @ObservedObject var webui: WebUIController

    var body: some View {
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
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
}

struct PreferencesTab: View {
    @ObservedObject var preferences: AppPreferences

    var body: some View {
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
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
}

struct SettingsView: View {
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

@MainActor
enum CloudConnection {
    static var isInstalled: Bool {
        FileManager.default.fileExists(
            atPath: NSHomeDirectory() + "/Library/LaunchAgents/dev.recallmemory.cloud-sync.plist"
        )
    }

    static func openConnect() {
        open(path: "/connect")
    }

    static func openMemories() {
        open(path: "/memories")
    }

    private static func open(path: String) {
        guard let url = URL(string: "https://app.recallmemory.dev\(path)") else { return }
        NSWorkspace.shared.open(url)
    }
}

struct StatusTile: View {
    let title: String
    let value: String
    let systemImage: String
    let active: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: systemImage)
                    .foregroundStyle(active ? Color.accentColor : .secondary)
                Spacer()
                Circle()
                    .fill(active ? Color.green : Color.gray.opacity(0.55))
                    .frame(width: 8, height: 8)
            }
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .lineLimit(1)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

struct CloudFeatureRow: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 28, height: 28)
                .background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct InlineNotice: View {
    let text: String
    let systemImage: String
    let color: Color

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: systemImage)
                .foregroundStyle(color)
            Text(text)
                .font(.caption)
                .textSelection(.enabled)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}


struct LabeledValue: View {
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
