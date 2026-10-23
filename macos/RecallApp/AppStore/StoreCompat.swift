import AppKit
import Combine
import SwiftUI

// The store edition compiles the direct app's sidebar views (DashboardShell,
// DashboardSections, AppPreferences). These types stand in for the direct app's
// launchd-based controllers so the same screens run on the app-owned service.

extension Notification.Name {
    static let recallOpenDashboard = Notification.Name("RecallOpenDashboard")
    static let recallOpenPreferences = Notification.Name("RecallOpenPreferences")
    static let recallOpenUpdates = Notification.Name("RecallOpenUpdates")
    static let recallRefreshStatus = Notification.Name("RecallRefreshStatus")
}

enum AppVersion {
    static let display: String = {
        let short = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        return "v\(short)"
    }()
}

enum AppLayout {
    static let horizontalPadding: CGFloat = 20
    static let titlebarTopPadding: CGFloat = 32
    static let bottomPadding: CGFloat = 20
}

/// Same surface as the direct app's DaemonController, backed by the service
/// this app starts and stops itself.
@MainActor
final class DaemonController: ObservableObject {
    let runtime: StoreRuntime
    @Published var launchdState = "Starting"
    @Published var healthText = "Starting local memory…"
    @Published var healthOK = false
    @Published var setupStatus = "Idle"
    @Published var setupRunning = false
    @Published var lastError: String?
    private var observation: AnyCancellable?

    init(runtime: StoreRuntime) {
        self.runtime = runtime
        observation = runtime.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { self?.refresh() }
        }
        refresh()
    }

    var dataDir: String { runtime.dataDirectory.path }
    var logDir: String { runtime.dataDirectory.appendingPathComponent("service.log").path }

    func refresh() {
        healthOK = runtime.ready
        launchdState = runtime.ready ? "Running" : runtime.status
        healthText = runtime.ready ? "Healthy" : (runtime.error ?? runtime.status)
        setupRunning = !runtime.ready && runtime.error == nil
        setupStatus = setupRunning ? runtime.status : "Idle"
        lastError = runtime.error
    }

    func start() { runtime.start() }
    func startDaemon() { runtime.start() }
    func stopDaemon() { Task { await runtime.stop() } }
    func restartDaemon() { Task { await runtime.restart() } }
    func openDataDir() { NSWorkspace.shared.open(runtime.dataDirectory) }
    func openLogDir() { runtime.openLog() }
}

/// Same surface as the direct app's WebUIController. The store edition shows
/// the dashboard inside the window instead of in a browser.
@MainActor
final class WebUIController: ObservableObject {
    @Published var running = false
    @Published var url: String?
    @Published var lastError: String?
    @Published var clientCount = 0
    private let daemon: DaemonController
    private var observation: AnyCancellable?

    init(daemon: DaemonController) {
        self.daemon = daemon
    }

    var dashboardURL: URL { daemon.runtime.dashboardURL }

    func start() {
        observation = daemon.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { self?.refresh() }
        }
        refresh()
    }

    func refresh() {
        running = daemon.runtime.ready
        url = running ? dashboardURL.absoluteString : nil
    }

    func openDashboard() { NotificationCenter.default.post(name: .recallOpenDashboard, object: nil) }
    func closeDashboard() {}
    func openInBrowser() { NSWorkspace.shared.open(dashboardURL) }
    var statusText: String { running ? "Running at \(dashboardURL.absoluteString)" : "Starting local memory…" }
}

/// Store updates arrive through the Mac App Store, so nothing is ever available.
@MainActor
final class UpdateController: ObservableObject {
    @Published var isAvailable = false
}

struct UpdateNotice: View {
    let updates: UpdateController
    var body: some View { EmptyView() }
}
