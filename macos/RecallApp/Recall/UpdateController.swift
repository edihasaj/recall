import AppKit
import Foundation

@MainActor
final class UpdateController: ObservableObject {
    @Published private(set) var latestVersion: String?
    @Published private(set) var ready = false
    @Published private(set) var checking = false
    @Published private(set) var installing = false
    @Published private(set) var phase = ""
    @Published var lastError: String?
    @Published private(set) var checkFailed = false

    let installedVersion: String
    private var pollingTask: Task<Void, Never>?

    /// Install verified releases without waiting for a click. On by default;
    /// the Updates tab turns it off.
    @Published var installAutomatically: Bool {
        didSet { UserDefaults.standard.set(installAutomatically, forKey: Self.automaticKey) }
    }
    /// Set by the app delegate: quits Recall so the helper can replace it.
    var onAutomaticInstall: (@MainActor () throws -> Void)?
    private static let automaticKey = "installUpdatesAutomatically"

    init() {
        installedVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        installAutomatically = UserDefaults.standard.object(forKey: Self.automaticKey) as? Bool ?? true
    }

    /// True when the daemon reports a complete, newer release that this copy
    /// can install itself, and that version has not already failed here.
    /// A failed version is never retried automatically, so a bad release can't
    /// restart Recall in a loop; the Install button still works.
    nonisolated static func shouldInstallAutomatically(
        enabled: Bool, available: Bool, canInstall: Bool, failedVersion: String?, latest: String?
    ) -> Bool {
        enabled && available && canInstall && latest != nil && failedVersion != latest
    }

    var isAvailable: Bool {
        ready && Self.isNewer(latestVersion, than: installedVersion)
    }

    var releaseURL: URL? {
        guard let latestVersion,
              let url = URL(string: "https://github.com/edihasaj/recall/releases/tag/v\(latestVersion)") else {
            return nil
        }
        return url
    }

    var canInstallInApp: Bool {
        Self.canInstallInApp(at: Bundle.main.bundlePath, homebrew: isHomebrewInstall,
                             writable: FileManager.default.isWritableFile(atPath:))
    }

    nonisolated static func canInstallInApp(at path: String, homebrew: Bool, writable: (String) -> Bool) -> Bool {
        path == "/Applications/Recall.app" &&
            (homebrew || writable("/Applications") && writable(path))
    }

    var isHomebrewInstall: Bool {
        brewPath != nil &&
            ["/opt/homebrew/Caskroom/recall", "/usr/local/Caskroom/recall"]
            .contains(where: FileManager.default.fileExists(atPath:))
    }

    var logPath: String { NSHomeDirectory() + "/.recall/logs/update.log" }
    private var resultPath: String { NSHomeDirectory() + "/.recall/updates/result" }

    func start() {
        loadLastUpdateResult()
        pollingTask?.cancel()
        pollingTask = Task {
            while !Task.isCancelled {
                await check()
                try? await Task.sleep(for: .seconds(lastError == nil ? 1800 : 60))
            }
        }
    }

    func check(force: Bool = false) async {
        guard !checking && !installing else { return }
        checking = true
        defer { checking = false }
        do {
            var url = URLComponents(string: "http://127.0.0.1:7890/update")!
            if force { url.queryItems = [URLQueryItem(name: "refresh", value: "1")] }
            var request = URLRequest(url: url.url!)
            request.timeoutInterval = 12
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                throw UpdateFailure.checkFailed
            }
            let report = try JSONDecoder().decode(UpdateReport.self, from: data)
            latestVersion = report.latest_version
            ready = report.ready
            if report.error != nil { throw UpdateFailure.checkFailed }
            checkFailed = false
            if !hasFailedUpdateResult { lastError = nil }
            if let onAutomaticInstall, Self.shouldInstallAutomatically(
                enabled: installAutomatically, available: isAvailable, canInstall: canInstallInApp,
                failedVersion: failedUpdateVersion, latest: latestVersion) {
                checking = false
                install(onInstalled: onAutomaticInstall)
            }
        } catch {
            checkFailed = true
            if !hasFailedUpdateResult {
                lastError = "Couldn’t check for updates. Try again in a moment."
            }
        }
    }

    func install(onInstalled: @escaping @MainActor () throws -> Void) {
        guard !installing, isAvailable, let latestVersion else { return }
        guard canInstallInApp else {
            if let releaseURL { NSWorkspace.shared.open(releaseURL) }
            return
        }
        installing = true
        lastError = nil
        Task {
            do {
                // Download while Recall still runs. The helper used to fetch
                // after the app quit, which kept Recall closed for a minute.
                phase = "Downloading Recall \(latestVersion)…"
                try await prefetch(version: latestVersion)
                phase = "Backing up local memories…"
                try await backupDatabase(for: latestVersion)
                phase = "Preparing the updater…"
                try launchHelper(for: latestVersion)
                phase = "Recall is closing for the update…"
                try onInstalled()
            } catch {
                lastError = "Update didn’t finish. Open the update log for details."
                installing = false
                phase = ""
            }
        }
    }

    func openLog() {
        NSWorkspace.shared.open(URL(fileURLWithPath: logPath))
    }

    private var brewPath: String? {
        ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
            .first(where: FileManager.default.isExecutableFile(atPath:))
    }

    /// The version named by a `failed<TAB>version` result, if any.
    private var failedUpdateVersion: String? {
        guard let raw = try? String(contentsOfFile: resultPath, encoding: .utf8), raw.hasPrefix("failed\t") else {
            return nil
        }
        return raw.dropFirst("failed\t".count).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var hasFailedUpdateResult: Bool {
        guard let raw = try? String(contentsOfFile: resultPath, encoding: .utf8) else { return false }
        return raw.hasPrefix("failed\t")
    }

    private func loadLastUpdateResult() {
        if hasFailedUpdateResult {
            lastError = "Update didn’t finish. Open the update log for details."
        }
    }

    private func launchHelper(for version: String) throws {
        let name = isHomebrewInstall ? "recall-update-macos" : "recall-update-direct-macos"
        let source = Bundle.main.bundlePath + "/Contents/Resources/Runtime/bin/" + name
        let directory = NSHomeDirectory() + "/.recall/updates"
        try FileManager.default.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let staged = directory + "/install-\(version).sh"
        try Data(contentsOf: URL(fileURLWithPath: source))
            .write(to: URL(fileURLWithPath: staged), options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: staged)
        try "pending\t\(version)\n".write(toFile: resultPath, atomically: true, encoding: .utf8)
        let helper = Process()
        helper.executableURL = URL(fileURLWithPath: staged)
        helper.arguments = isHomebrewInstall
            ? [version, String(ProcessInfo.processInfo.processIdentifier)]
            : ["install", version, Bundle.main.bundlePath, String(ProcessInfo.processInfo.processIdentifier)]
        try helper.run()
    }

    private func prefetch(version: String) async throws {
        if !isHomebrewInstall {
            let helper = Bundle.main.bundlePath + "/Contents/Resources/Runtime/bin/recall-update-direct-macos"
            try await Self.run(helper, ["prepare", version, Bundle.main.bundlePath], logPath: logPath)
            return
        }
        guard let brewPath else { throw UpdateFailure.commandFailed }
        try await Self.run("/bin/echo", ["Downloading Recall v\(version)"], logPath: logPath)
        try await Self.run(brewPath, ["update"], logPath: logPath)
        try await Self.run(brewPath, ["fetch", "--cask", "recall"], logPath: logPath,
                           environment: ["HOMEBREW_NO_AUTO_UPDATE": "1"])
    }

    private func backupDatabase(for version: String) async throws {
        let dbPath = NSHomeDirectory() + "/.recall/recall.db"
        guard FileManager.default.fileExists(atPath: dbPath) else { return }
        let stamp = DateFormatter()
        stamp.timeZone = TimeZone(secondsFromGMT: 0)
        stamp.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        let directory = NSHomeDirectory() + "/.recall/backups/published-\(version)-\(stamp.string(from: Date()))"
        try FileManager.default.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let runtime = Bundle.main.bundlePath + "/Contents/Resources/Runtime"
        let script = """
            const Database = require(process.argv[1]);
            const db = new Database(process.argv[2]);
            db.backup(process.argv[3]).then(() => db.close()).catch(error => {
              console.error(error.message); process.exitCode = 1;
            });
            """
        let destination = directory + "/recall.db"
        try await Self.run(runtime + "/bin/node", [
            "-e", script, runtime + "/node_modules/better-sqlite3", dbPath, destination,
        ], logPath: logPath)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination)
    }

    private static func isNewer(_ latest: String?, than current: String) -> Bool {
        func parts(_ version: String) -> [Int]? {
            let values = version.trimmingCharacters(in: CharacterSet(charactersIn: "v"))
                .split(separator: ".").compactMap { Int($0) }
            return values.count == 3 ? values : nil
        }
        guard let latest, let next = parts(latest), let installed = parts(current) else { return false }
        for (a, b) in zip(next, installed) where a != b { return a > b }
        return false
    }

    private nonisolated static func run(
        _ executable: String,
        _ arguments: [String],
        logPath: String,
        environment: [String: String] = [:]
    ) async throws {
        try await Task.detached(priority: .userInitiated) {
            let logURL = URL(fileURLWithPath: logPath)
            try FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: logPath) {
                guard FileManager.default.createFile(atPath: logPath, contents: nil) else {
                    throw UpdateFailure.commandFailed
                }
            }
            guard let output = FileHandle(forWritingAtPath: logPath) else { throw UpdateFailure.commandFailed }
            defer { try? output.close() }
            output.seekToEndOfFile()
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            if !environment.isEmpty {
                process.environment = ProcessInfo.processInfo.environment.merging(environment) { $1 }
            }
            process.standardOutput = output
            process.standardError = output
            try process.run()
            process.waitUntilExit()
            if process.terminationStatus != 0 { throw UpdateFailure.commandFailed }
        }.value
    }
}

private enum UpdateFailure: Error {
    case checkFailed, commandFailed
}

private struct UpdateReport: Decodable {
    let latest_version: String?
    let ready: Bool
    let error: String?
}
