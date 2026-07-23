import AppKit
import SwiftUI

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
        .onReceive(NotificationCenter.default.publisher(for: .recallOpenPreferences)) { _ in
            selection = .preferences
        }
    }
}

private enum AppSection: String, Hashable, CaseIterable {
    case overview, cloud, daemon, webui, preferences

    var label: String {
        switch self {
        case .overview: return "Overview"
        case .cloud: return "Recall Cloud"
        case .daemon: return "Daemon"
        case .webui: return "Web Dashboard"
        case .preferences: return "Preferences"
        }
    }

    var systemImage: String {
        switch self {
        case .overview: return "square.grid.2x2.fill"
        case .cloud: return "cloud.fill"
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
        .background(
            LinearGradient(
                colors: [Color.accentColor.opacity(0.08), Color.clear],
                startPoint: .topLeading,
                endPoint: .center
            )
        )
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

            HStack(spacing: 8) {
                Circle()
                    .fill(CloudConnection.isInstalled ? Color.green : Color.gray.opacity(0.6))
                    .frame(width: 8, height: 8)
                Text(CloudConnection.isInstalled ? "Cloud sync connected" : "Cloud sync not connected")
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
                    case .cloud:
                        CloudTab()
                    case .daemon:
                        DaemonTab(controller: controller, webui: webui)
                    case .webui:
                        WebDashboardTab(webui: webui)
                    case .preferences:
                        PreferencesTab(preferences: preferences)
                    }
                }
                .padding(.horizontal, 28)
                .padding(.vertical, 24)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
        .background(
            LinearGradient(
                colors: [Color.accentColor.opacity(0.035), Color.clear],
                startPoint: .topTrailing,
                endPoint: .center
            )
        )
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
            return "Your local memory system at a glance."
        case .cloud:
            return "One memory layer across every Mac and agent."
        case .daemon:
            return "Local HTTP daemon · lifecycle, paths, logs."
        case .webui:
            return "Browser-based dashboard on http://localhost:7891."
        case .preferences:
            return "Startup and appearance options."
        }
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

