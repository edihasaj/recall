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

    let dataDir = NSHomeDirectory() + "/.recall"
    let logDir = NSHomeDirectory() + "/.recall/logs"

    private let label = "com.recall.daemon"
    private var refreshTask: Task<Void, Never>?

    var summary: String {
        "Production Recall app. Bundled runtime. Launchd-managed daemon."
    }

    func start() {
        refresh()
        if !healthOK && launchdState != "Not loaded" {
            startDaemon()
        } else if !healthOK {
            setupStatus = "Install required"
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

        Task.detached { [weak self] in
            do {
                for args in commands {
                    _ = try Self.runShell(nodePath, [cliPath] + args)
                }
                await MainActor.run {
                    self?.lastError = nil
                    self?.refresh()
                }
            } catch {
                await MainActor.run {
                    self?.setupRunning = false
                    self?.lastError = String(describing: error)
                    self?.refresh()
                }
            }
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
