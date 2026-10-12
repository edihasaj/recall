import AppKit
import ServiceManagement

@MainActor
final class AppPreferences: ObservableObject {
    @Published private(set) var showDockIcon: Bool
    @Published private(set) var showMenuBarIcon: Bool
    @Published private(set) var launchAtLogin: Bool
    @Published private(set) var loginItemStatusText = "Checking"

    private let defaults = UserDefaults.standard
    private let dockKey = "showDockIcon"
    private let menuBarKey = "showMenuBarIcon"
    private let launchAtLoginKey = "launchAtLogin"
    private var dashboardVisible = false

    init() {
        self.showDockIcon = defaults.object(forKey: dockKey) as? Bool ?? false
        self.showMenuBarIcon = defaults.object(forKey: menuBarKey) as? Bool ?? true
        self.launchAtLogin = defaults.object(forKey: launchAtLoginKey) as? Bool ?? true
        Self.applyBundledAppIcon()
        applyActivationPolicy()
        syncLaunchAtLogin()
    }

    func setShowDockIcon(_ enabled: Bool) {
        showDockIcon = enabled
        defaults.set(enabled, forKey: dockKey)
        applyActivationPolicy()
    }

    func setDashboardVisible(_ visible: Bool) {
        guard dashboardVisible != visible else { return }
        dashboardVisible = visible
        applyActivationPolicy()
    }

    /// Hiding the menu bar icon keeps Recall running in the background.
    /// Opening Recall.app again brings the dashboard back.
    func setShowMenuBarIcon(_ enabled: Bool) {
        showMenuBarIcon = enabled
        defaults.set(enabled, forKey: menuBarKey)
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        launchAtLogin = enabled
        defaults.set(enabled, forKey: launchAtLoginKey)
        syncLaunchAtLogin()
    }

    func syncLaunchAtLogin() {
        guard #available(macOS 13.0, *) else {
            loginItemStatusText = "Unsupported on this macOS version"
            return
        }
        guard Self.isRunningFromApplications else {
            loginItemStatusText = "Install Recall.app in /Applications to enable"
            return
        }

        do {
            let service = SMAppService.mainApp
            if launchAtLogin {
                switch service.status {
                case .enabled, .requiresApproval:
                    break
                default:
                    try service.register()
                }
            } else if service.status == .enabled || service.status == .requiresApproval {
                try service.unregister()
            }
            refreshLoginItemStatus()
        } catch {
            loginItemStatusText = "Error: \(error.localizedDescription)"
        }
    }

    func refreshLoginItemStatus() {
        guard #available(macOS 13.0, *) else {
            loginItemStatusText = "Unsupported on this macOS version"
            return
        }
        guard Self.isRunningFromApplications else {
            loginItemStatusText = "Install Recall.app in /Applications to enable"
            return
        }

        switch SMAppService.mainApp.status {
        case .enabled:
            loginItemStatusText = "Enabled"
        case .requiresApproval:
            loginItemStatusText = "Requires approval in System Settings"
        case .notRegistered:
            loginItemStatusText = launchAtLogin ? "Not registered" : "Off"
        case .notFound:
            loginItemStatusText = "App not found"
        @unknown default:
            loginItemStatusText = "Unknown"
        }
    }

    func applyActivationPolicy() {
        Self.applyBundledAppIcon()
        let policy: NSApplication.ActivationPolicy = showDockIcon || dashboardVisible ? .regular : .accessory
        NSApp.setActivationPolicy(policy)
        if showDockIcon || dashboardVisible {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    static func applyBundledAppIcon() {
        guard let path = Bundle.main.path(forResource: "AppIcon", ofType: "icns"),
              let image = NSImage(contentsOfFile: path) else { return }
        NSApplication.shared.applicationIconImage = image
    }

    private static var isRunningFromApplications: Bool {
        Bundle.main.bundleURL
            .resolvingSymlinksInPath()
            .standardizedFileURL
            .path == "/Applications/Recall.app"
    }
}
