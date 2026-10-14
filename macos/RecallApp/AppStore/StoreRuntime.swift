import AppKit
import Foundation

@MainActor
final class StoreRuntime: ObservableObject {
    @Published private(set) var ready = false
    @Published private(set) var status = "Starting local memory…"
    @Published private(set) var error: String?
    @Published private(set) var folders: [URL] = []
    let port: Int
    let webPort: Int
    let dataDirectory: URL
    var dashboardURL: URL { URL(string: "http://127.0.0.1:\(webPort)")! }
    var origin: String { "http://127.0.0.1:\(port)" }
    private var child: Process?
    private var log: FileHandle?
    private var startup: Task<Void, Never>?
    private var wantsRunning = false
    private var generation = 0
    private var failures = 0
    private var scopedFolders: [URL] = []
    private let defaults = UserDefaults.standard

    init(port: Int = 7892, webPort: Int = 7893, dataDirectory: URL? = nil) {
        self.port = port
        self.webPort = webPort
        self.dataDirectory = dataDirectory ?? FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask
        )[0].appendingPathComponent("Recall", isDirectory: true)
        restoreFolders()
    }

    func start() {
        guard child == nil else { return }
        wantsRunning = true
        ready = false
        startup?.cancel()
        generation += 1
        let current = generation
        let identifier = UUID().uuidString
        do {
            try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
            let logURL = dataDirectory.appendingPathComponent("service.log")
            if !FileManager.default.fileExists(atPath: logURL.path) {
                FileManager.default.createFile(atPath: logURL.path, contents: nil)
            }
            log = try FileHandle(forWritingTo: logURL)
            try log?.seekToEnd()
            let runtime = Bundle.main.resourceURL!.appendingPathComponent("StoreRuntime")
            let process = Process()
            process.executableURL = runtime.appendingPathComponent("bin/node")
            process.arguments = [runtime.appendingPathComponent("dist/daemon.js").path]
            process.currentDirectoryURL = runtime
            // Only service configuration enters the child, never the developer shell's credentials.
            process.environment = [
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                "RECALL_DATA_DIR": dataDirectory.path,
                "RECALL_EMBEDDING_CACHE_DIR": dataDirectory.appendingPathComponent("Models").path,
                "RECALL_PORT": "\(port)", "RECALL_WEBUI_PORT": "\(webPort)",
                "RECALL_INSTANCE_ID": identifier, "RECALL_DISTRIBUTION": "mac-app-store",
                "RECALL_DISPATCHER_ENABLED": "false",
            ]
            process.standardOutput = log
            process.standardError = log
            process.terminationHandler = { [weak self] process in
                let code = process.terminationStatus
                Task { @MainActor in self?.didExit(code: code, generation: current) }
            }
            try process.run()
            child = process
            status = "Starting local memory…"
            startup = Task { [weak self] in
                guard let self else { return }
                do {
                    for _ in 0..<120 {
                        try Task.checkCancellation()
                        guard current == generation else { return }
                        if let health = try? await request("/health"),
                           health["instance_id"] as? String == identifier {
                            _ = try await request("/webui/start", body: ["port": webPort, "open": false])
                            ready = true
                            status = "Local memory is ready"
                            error = nil
                            failures = 0
                            return
                        }
                        try await Task.sleep(for: .milliseconds(250))
                    }
                    error = "Local memory did not start. Open the service log for details."
                } catch is CancellationError {
                } catch {
                    self.error = error.localizedDescription
                }
            }
        } catch {
            self.error = error.localizedDescription
            child = nil
            wantsRunning = false
        }
    }

    func stop() async {
        wantsRunning = false
        generation += 1
        startup?.cancel()
        startup = nil
        let process = child
        child = nil
        ready = false
        process?.terminate()
        for _ in 0..<40 where process?.isRunning == true {
            try? await Task.sleep(for: .milliseconds(100))
        }
        if let process, process.isRunning {
            kill(process.processIdentifier, SIGKILL)
        }
        try? log?.close()
        log = nil
        status = "Local memory is stopped"
    }

    func restart() async {
        await stop()
        start()
    }

    private func didExit(code: Int32, generation: Int) {
        guard generation == self.generation else { return }
        child = nil
        ready = false
        try? log?.close()
        log = nil
        guard wantsRunning else { return }
        failures += 1
        error = "The local service stopped (code \(code))."
        guard failures <= 3 else {
            wantsRunning = false
            status = "Start local memory to try again"
            return
        }
        status = "Restarting local memory…"
        startup = Task {
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled, wantsRunning else { return }
            start()
        }
    }

    func request(_ path: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: origin + path)!)
        request.timeoutInterval = 20
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw NSError(domain: "RecallStore", code: 1, userInfo: [
                NSLocalizedDescriptionKey: String(decoding: data, as: UTF8.self),
            ])
        }
        return (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "Choose a repository folder Recall may read for scans and context."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let bookmark = try url.bookmarkData(
                options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess],
                includingResourceValuesForKeys: nil, relativeTo: nil)
            var bookmarks = defaults.array(forKey: "store.repositoryBookmarks") as? [Data] ?? []
            if folders.contains(url) { return }
            bookmarks.append(bookmark)
            defaults.set(bookmarks, forKey: "store.repositoryBookmarks")
            restoreFolders()
            Task { await restart() }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func removeFolder(_ url: URL) {
        var bookmarks = defaults.array(forKey: "store.repositoryBookmarks") as? [Data] ?? []
        bookmarks.removeAll { data in
            var stale = false
            let resolved = try? URL(resolvingBookmarkData: data, options: [.withSecurityScope],
                                   relativeTo: nil, bookmarkDataIsStale: &stale)
            return resolved == url
        }
        defaults.set(bookmarks, forKey: "store.repositoryBookmarks")
        restoreFolders()
        Task { await restart() }
    }

    private func restoreFolders() {
        for url in scopedFolders { url.stopAccessingSecurityScopedResource() }
        scopedFolders = []
        folders = []
        let bookmarks = defaults.array(forKey: "store.repositoryBookmarks") as? [Data] ?? []
        for data in bookmarks {
            var stale = false
            guard let url = try? URL(resolvingBookmarkData: data, options: [.withSecurityScope],
                                    relativeTo: nil, bookmarkDataIsStale: &stale) else { continue }
            if url.startAccessingSecurityScopedResource() { scopedFolders.append(url) }
            folders.append(url)
        }
    }

    func openLog() { NSWorkspace.shared.open(dataDirectory.appendingPathComponent("service.log")) }
}
