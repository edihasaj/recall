import AppKit
import Foundation

@MainActor
final class DaemonController: ObservableObject {
    @Published var launchdState = "Unknown"
    @Published var healthText = "Unavailable"
    @Published var healthOK = false
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
        if !healthOK {
            installAndStart()
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
        } catch {
            healthOK = false
            healthText = "Offline"
        }
    }

    func installAndStart() {
        runRecall("daemon", "install", "--node-path", runtimeNodePath, "--daemon-script", runtimeDaemonPath)
    }

    func startDaemon() {
        runRecall("daemon", "start")
    }

    func stopDaemon() {
        runRecall("daemon", "stop")
    }

    func restartDaemon() {
        runRecall("daemon", "restart")
    }

    func openDataDir() {
        NSWorkspace.shared.open(URL(fileURLWithPath: dataDir))
    }

    func openLogDir() {
        NSWorkspace.shared.open(URL(fileURLWithPath: logDir))
    }

    private func runRecall(_ args: String...) {
        do {
            _ = try shell(runtimeNodePath, [runtimeCliPath] + args)
            lastError = nil
            refresh()
        } catch {
            lastError = String(describing: error)
            refresh()
        }
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

    private func shell(_ launchPath: String, _ args: String...) throws -> String {
        try shell(launchPath, args)
    }

    private func shell(_ launchPath: String, _ args: [String]) throws -> String {
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
