import AppKit
import Foundation

@MainActor
final class DaemonController: ObservableObject {
    @Published var launchdState = "Unknown"
    @Published var healthText = "Unavailable"
    @Published var healthOK = false
    @Published var setupStatus = "Idle"
    @Published var setupRunning = false
    @Published var lastError: String?
    @Published var daemonVersion = ""

    let dataDir = NSHomeDirectory() + "/.recall"
    let logDir = NSHomeDirectory() + "/.recall/logs"

    private let label = "com.recall.daemon"
    private var refreshTask: Task<Void, Never>?
    private var didAutoRestartForVersion = false

    var summary: String {
        "Production Recall app. Bundled runtime. Launchd-managed daemon."
    }

    func start() {
        refresh()
        if !healthOK && launchdState != "Not loaded" {
            startDaemon()
        } else if !healthOK {
            setupStatus = "Install required"
        } else {
            restartIfBundleNewerThanRunning()
        }
        refreshTask?.cancel()
        refreshTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(8))
                refresh()
            }
        }
    }

    func refresh() {
        do {
            let launchd = try shell("/bin/launchctl", "print", "gui/\(uid())/\(label)")
            launchdState = launchd.contains("state = running") ? "Running" : "Loaded"
        } catch {
            launchdState = "Not loaded"
        }

        do {
            let health = try shell("/usr/bin/curl", "-sf", "http://localhost:7890/health")
            healthOK = health.contains("\"status\":\"ok\"")
            healthText = healthOK ? "OK" : "Unexpected"
            if healthOK {
                setupRunning = false
                setupStatus = "Ready"
                if let version = Self.jsonString(health, key: "version") {
                    daemonVersion = version
                }
            }
        } catch {
            healthOK = false
            healthText = "Offline"
        }

        if !healthOK {
            updateSetupStatusFromLogs()
        }
    }

    func installAndStart() {
        runRecallCommandsInBackground(
            status: "Installing daemon and agent integrations",
            [
                ["daemon", "install", "--node-path", runtimeNodePath, "--daemon-script", runtimeDaemonPath],
                ["setup", "--app-path", Bundle.main.bundlePath, "--yes"]
            ]
        )
    }

    func startDaemon() {
        runRecallInBackground(status: "Starting daemon", "daemon", "start")
    }

    func stopDaemon() {
        runRecallInBackground(status: "Stopping daemon", "daemon", "stop")
    }

    func restartDaemon() {
        runRecallInBackground(status: "Restarting daemon", "daemon", "restart")
    }

    /// After a bundle update (e.g. `brew upgrade`) the launchd daemon keeps
    /// running the previously-installed code — it stays healthy, so nothing
    /// bounces it and the UI reports the old version. When the running daemon's
    /// version differs from the bundled runtime, restart it once so the served
    /// UI and reported version match the installed app.
    private func restartIfBundleNewerThanRunning() {
        guard !didAutoRestartForVersion, !daemonVersion.isEmpty else { return }
        guard let bundled = bundledVersion(), bundled != daemonVersion else { return }
        didAutoRestartForVersion = true
        setupStatus = "Updating daemon to \(bundled)"
        restartDaemon()
    }

    private func bundledVersion() -> String? {
        let pkgPath = URL(fileURLWithPath: runtimeRoot)
            .appendingPathComponent("package.json").path
        guard let data = FileManager.default.contents(atPath: pkgPath) else { return nil }
        return Self.jsonString(String(decoding: data, as: UTF8.self), key: "version")
    }

    private nonisolated static func jsonString(_ json: String, key: String) -> String? {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = object[key] as? String else { return nil }
        return value
    }

    func openDataDir() {
        NSWorkspace.shared.open(URL(fileURLWithPath: dataDir))
    }

    func openLogDir() {
        NSWorkspace.shared.open(URL(fileURLWithPath: logDir))
    }

    private func runRecallInBackground(status: String, _ args: String...) {
        runRecallCommandsInBackground(status: status, [args])
    }

    private func runRecallCommandsInBackground(status: String, _ commands: [[String]]) {
        setupRunning = true
        setupStatus = status
        lastError = nil

        let nodePath = runtimeNodePath
        let cliPath = runtimeCliPath

        Task { [weak self, commands, nodePath, cliPath] in
            let errorText = await Task.detached(priority: .userInitiated) { () -> String? in
                do {
                    for args in commands {
                        _ = try Self.runShell(nodePath, [cliPath] + args)
                    }
                    return nil
                } catch {
                    return String(describing: error)
                }
            }.value

            if let errorText {
                self?.setupRunning = false
                self?.lastError = errorText
            } else {
                self?.lastError = nil
            }
            self?.refresh()
        }
    }

    private func updateSetupStatusFromLogs() {
        let logText = recentLogText()
        if logText.contains("rollout: bootstrapping history embeddings") {
            setupRunning = true
            setupStatus = "Bootstrapping history embeddings"
        } else if logText.contains("rollout: bootstrapping memory embeddings") {
            setupRunning = true
            setupStatus = "Bootstrapping memory embeddings"
        } else if logText.contains("rollout: scanning") {
            setupRunning = true
            setupStatus = "Scanning local repositories"
        } else if logText.contains("rollout: resetting local memory store") {
            setupRunning = true
            setupStatus = "Resetting local memory store"
        } else if logText.contains("Fetching embedding model") {
            setupRunning = true
            setupStatus = "Fetching embedding model"
        } else if launchdState == "Running" || launchdState == "Loaded" {
            setupRunning = true
            setupStatus = "Starting daemon"
        } else if !setupRunning {
            setupStatus = "Idle"
        }
    }

    private func recentLogText() -> String {
        let stdout = (try? String(contentsOfFile: logDir + "/daemon.stdout.log", encoding: .utf8)) ?? ""
        let stderr = (try? String(contentsOfFile: logDir + "/daemon.stderr.log", encoding: .utf8)) ?? ""
        let combined = stdout + "\n" + stderr
        return String(combined.suffix(4000))
    }

    private var runtimeRoot: String {
        Bundle.main.resourceURL!.appendingPathComponent("Runtime", isDirectory: true).path
    }

    private var runtimeNodePath: String {
        URL(fileURLWithPath: runtimeRoot).appendingPathComponent("bin/node").path
    }

    private var runtimeCliPath: String {
        URL(fileURLWithPath: runtimeRoot).appendingPathComponent("dist/cli.js").path
    }

    private var runtimeDaemonPath: String {
        URL(fileURLWithPath: runtimeRoot).appendingPathComponent("dist/daemon.js").path
    }

    private func uid() -> Int {
        Int(getuid())
    }

    private nonisolated func shell(_ launchPath: String, _ args: String...) throws -> String {
        try Self.runShell(launchPath, args)
    }

    private nonisolated func shell(_ launchPath: String, _ args: [String]) throws -> String {
        try Self.runShell(launchPath, args)
    }

    private nonisolated static func runShell(_ launchPath: String, _ args: [String]) throws -> String {
        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = args
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        process.waitUntilExit()

        let out = String(data: stdout.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let err = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        guard process.terminationStatus == 0 else {
            throw NSError(domain: "RecallApp", code: Int(process.terminationStatus), userInfo: [
                NSLocalizedDescriptionKey: err.isEmpty ? out : err
            ])
        }
        return out
    }
}
