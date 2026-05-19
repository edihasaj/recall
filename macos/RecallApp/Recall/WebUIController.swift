import AppKit
import Foundation

/// Drives the WebUI dashboard from the menubar. Talks to the daemon over
/// localhost HTTP — no direct file access — so the same control surface
/// works whether the daemon is in-process or launchd-managed.
@MainActor
final class WebUIController: ObservableObject {
    @Published var running: Bool = false
    @Published var url: String? = nil
    @Published var lastError: String? = nil
    @Published var clientCount: Int = 0

    private let daemonPort: Int = 7890
    private var pollTask: Task<Void, Never>?

    func start() {
        refresh()
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(6))
                refresh()
            }
        }
    }

    func openDashboard() {
        Task { [daemonPort] in
            do {
                // open=false: the daemon used to launch the browser too, which
                // produced a second tab on top of the NSWorkspace.open below.
                // Single source of truth → the app opens it.
                let status = try await Self.postJson(
                    url: "http://localhost:\(daemonPort)/webui/start",
                    body: ["open": false]
                )
                await MainActor.run {
                    self.applyStatus(status)
                    if let urlString = self.url, let url = URL(string: urlString) {
                        NSWorkspace.shared.open(url)
                    }
                }
            } catch {
                await MainActor.run {
                    self.lastError = "Could not start WebUI: \(error.localizedDescription)"
                }
            }
        }
    }

    func closeDashboard() {
        Task { [daemonPort] in
            do {
                let status = try await Self.postJson(
                    url: "http://localhost:\(daemonPort)/webui/stop",
                    body: [:]
                )
                await MainActor.run { self.applyStatus(status) }
            } catch {
                await MainActor.run {
                    self.lastError = "Could not stop WebUI: \(error.localizedDescription)"
                }
            }
        }
    }

    func openInBrowser() {
        guard let urlString = self.url, let url = URL(string: urlString) else { return }
        NSWorkspace.shared.open(url)
    }

    func refresh() {
        Task { [daemonPort] in
            do {
                let status = try await Self.getJson(
                    url: "http://localhost:\(daemonPort)/webui/status"
                )
                await MainActor.run { self.applyStatus(status) }
            } catch {
                await MainActor.run {
                    self.running = false
                    self.url = nil
                }
            }
        }
    }

    private func applyStatus(_ status: [String: Any]) {
        self.running = (status["running"] as? Bool) ?? false
        self.url = status["url"] as? String
        self.clientCount = (status["client_count"] as? Int) ?? 0
        if self.running { self.lastError = nil }
    }

    var statusText: String {
        if let err = lastError { return err }
        if !running { return "Off" }
        if let url { return "Running at \(url)" }
        return "Running"
    }

    // MARK: HTTP helpers

    private static func getJson(url: String) async throws -> [String: Any] {
        guard let u = URL(string: url) else {
            throw NSError(domain: "WebUIController", code: 1, userInfo: [NSLocalizedDescriptionKey: "bad url"])
        }
        let (data, response) = try await URLSession.shared.data(from: u)
        try Self.requireOk(response, data: data)
        return try parseJsonObject(data)
    }

    private static func postJson(url: String, body: [String: Any]) async throws -> [String: Any] {
        guard let u = URL(string: url) else {
            throw NSError(domain: "WebUIController", code: 1, userInfo: [NSLocalizedDescriptionKey: "bad url"])
        }
        var req = URLRequest(url: u)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        let (data, response) = try await URLSession.shared.data(for: req)
        try Self.requireOk(response, data: data)
        return try parseJsonObject(data)
    }

    private static func requireOk(_ response: URLResponse, data: Data) throws {
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw NSError(domain: "WebUIController", code: http.statusCode, userInfo: [
                NSLocalizedDescriptionKey: "HTTP \(http.statusCode): \(body)"
            ])
        }
    }

    private static func parseJsonObject(_ data: Data) throws -> [String: Any] {
        let obj = try JSONSerialization.jsonObject(with: data, options: [])
        guard let dict = obj as? [String: Any] else {
            throw NSError(domain: "WebUIController", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "expected JSON object"
            ])
        }
        return dict
    }
}
