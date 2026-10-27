import AppKit
import SwiftUI

/// Mirror of the daemon's GET /cloud/status. Nothing here is secret: the daemon
/// never returns the token, passphrase or raw sync-engine output.
struct CloudStatusSnapshot: Decodable, Equatable {
    struct Worker: Decodable, Equatable {
        var pid: Int?
        var startedAt: String?
        var restarts: Int
        var lastSyncAt: String?
    }

    struct Config: Decodable, Equatable {
        var api: String
        var deviceId: String
        var intervalSeconds: Int
        var e2ee: Bool
        var migratedFrom: String?
        var optInAt: String?
        var queryEnrichment: Bool?
    }

    struct Legacy: Decodable, Equatable {
        var detected: Bool
        var loaded: Bool
        var unknown: Bool?
        var canMigrate: Bool
    }

    var available: Bool
    var state: String
    var enabled: Bool
    var worker: Worker
    var config: Config?
    var legacy: Legacy
    var error: String?
}

enum CloudClient {
    struct APIError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private static let base = "http://127.0.0.1:7890"

    static func status() async throws -> CloudStatusSnapshot {
        try await send(path: "/cloud/status", method: "GET", body: nil)
    }

    static func post(_ path: String, body: Data) async throws -> CloudStatusSnapshot {
        try await send(path: path, method: "POST", body: body)
    }

    private static func send(path: String, method: String, body: Data?) async throws -> CloudStatusSnapshot {
        guard let url = URL(string: base + path) else { throw APIError(message: "Invalid daemon address") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw APIError(message: "Recall's background service is not reachable yet. Try again in a moment.")
        }
        guard let http = response as? HTTPURLResponse else { throw APIError(message: "Unexpected daemon response") }
        guard (200..<300).contains(http.statusCode) else {
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw APIError(message: object?["error"] as? String ?? "Cloud request failed (\(http.statusCode))")
        }
        return try JSONDecoder().decode(CloudStatusSnapshot.self, from: data)
    }
}

/// Shared by the Cloud tab, the overview tile and the sidebar so they always
/// agree with what the daemon is actually doing.
@MainActor
final class CloudStatusModel: ObservableObject {
    static let shared = CloudStatusModel()

    @Published private(set) var snapshot: CloudStatusSnapshot?
    @Published private(set) var busy = false
    @Published var message: String?

    private var pollTask: Task<Void, Never>?

    /// True only after a full sync cycle succeeded: "connected" is never claimed from process startup alone.
    var isSynced: Bool {
        guard let snapshot else { return false }
        return snapshot.state == "running" && snapshot.worker.lastSyncAt != nil && snapshot.error == nil
    }

    var isConfigured: Bool { snapshot?.enabled ?? false }

    var summary: String {
        guard let snapshot else { return "Checking" }
        switch snapshot.state {
        case "unavailable": return "Not available"
        case "disconnected": return "Not connected"
        case "migration-pending": return "Needs attention"
        case "running": return isSynced ? "Syncing" : "Checking credentials"
        case "starting": return "Starting"
        case "backoff": return "Retrying"
        case "failed": return "Error"
        default: return "Stopped"
        }
    }

    func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(6))
            }
        }
    }

    func refresh() async {
        guard !busy else { return }
        do {
            snapshot = try await CloudClient.status()
        } catch {
            snapshot = nil
        }
    }

    func connect(token: String, passphrase: String, optIn: Bool) async -> Bool {
        var body: [String: Any] = ["token": token.trimmingCharacters(in: .whitespacesAndNewlines), "optIn": optIn]
        if !passphrase.isEmpty { body["e2eePassphrase"] = passphrase }
        return await perform("/cloud/connect", body)
    }

    func migrate(optIn: Bool) async -> Bool {
        await perform("/cloud/migrate", ["optIn": optIn])
    }

    func disconnect() async {
        _ = await perform("/cloud/disconnect", [:])
    }

    func setQueryEnrichment(_ enabled: Bool) async {
        _ = await perform("/cloud/query", ["enabled": enabled])
    }

    private func perform(_ path: String, _ body: [String: Any]) async -> Bool {
        busy = true
        message = nil
        var succeeded = false
        do {
            let data = try JSONSerialization.data(withJSONObject: body)
            snapshot = try await CloudClient.post(path, body: data)
            succeeded = true
        } catch {
            message = error.localizedDescription
        }
        busy = false
        // refresh() is skipped while busy, so pending-migration state is re-read only after the reset.
        if !succeeded { await refresh() }
        return succeeded
    }
}

enum CloudLinks {
    static func openPortal(path: String) {
        guard let url = URL(string: "https://app.recallmemory.dev\(path)") else { return }
        NSWorkspace.shared.open(url)
    }
}

struct CloudTab: View {
    @ObservedObject private var cloud = CloudStatusModel.shared
    @State private var token = ""
    @State private var passphrase = ""
    @State private var optIn = false

    private var snapshot: CloudStatusSnapshot? { cloud.snapshot }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header
            if let message = cloud.message {
                InlineNotice(text: message, systemImage: "exclamationmark.triangle.fill", color: .orange)
            }
            content
            features
        }
        .task { cloud.startPolling() }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 18) {
            Image(systemName: "cloud.fill")
                .font(.system(size: 32, weight: .semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 58, height: 58)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 16))
            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                    .font(.system(size: 23, weight: .bold, design: .rounded))
                Text(subtitle)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding(22)
        .background(.quaternary.opacity(0.55), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var title: String {
        guard let snapshot else { return "Recall Cloud" }
        if !snapshot.available { return "Not available in this edition" }
        if snapshot.enabled { return cloud.isSynced ? "This Mac is syncing" : "Cloud sync is set up" }
        return "Take Recall everywhere"
    }

    private var subtitle: String {
        guard let snapshot else { return "Waiting for Recall's background service." }
        if !snapshot.available { return "The Mac App Store edition keeps all memory on this Mac." }
        if snapshot.enabled {
            return "Recall syncs memories in both directions. Online retrieval can add relevant Cloud memories to agent queries."
        }
        return "Sync is off until you connect. Nothing leaves this Mac before then."
    }

    @ViewBuilder
    private var content: some View {
        if let snapshot, snapshot.available {
            if snapshot.enabled {
                connectedCard(snapshot)
            } else if snapshot.legacy.canMigrate {
                migrateCard
            } else {
                connectCard(snapshot)
            }
        }
    }

    private func connectedCard(_ snapshot: CloudStatusSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            LabeledValue(label: "Status", value: cloud.summary)
            if let config = snapshot.config {
                LabeledValue(label: "Device", value: config.deviceId)
                LabeledValue(label: "Cloud", value: config.api)
                LabeledValue(label: "Encrypt", value: config.e2ee ? "End-to-end encrypted" : "Standard")
                if !config.e2ee {
                    Toggle("Use Cloud memories in agent queries", isOn: Binding(
                        get: { cloud.snapshot?.config?.queryEnrichment ?? true },
                        set: { enabled in Task { await cloud.setQueryEnrichment(enabled) } }
                    ))
                    .disabled(cloud.busy)
                    Text("Sends question text to your Cloud to find relevant memories. Local retrieval stays available when offline.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            LabeledValue(label: "Last sync", value: snapshot.worker.lastSyncAt ?? "No successful sync yet")
            if let error = snapshot.error {
                InlineNotice(text: error, systemImage: "exclamationmark.triangle.fill", color: .orange)
            }
            HStack(spacing: 10) {
                Button(role: .destructive) {
                    Task { await cloud.disconnect() }
                } label: {
                    Label("Disconnect", systemImage: "icloud.slash")
                }
                .disabled(cloud.busy)
                Button {
                    CloudLinks.openPortal(path: "/memories")
                } label: {
                    Label("Cloud Memories", systemImage: "brain.head.profile")
                }
            }
            .controlSize(.large)
            Text("Disconnect stops sync and online retrieval and removes this Mac's saved token. Memories already in the cloud stay until you delete them there.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(18)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var migrateCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Recall Cloud Sync is already installed separately")
                .font(.system(size: 14, weight: .semibold))
            Text("Move it into Recall to run as part of this app. Your device name, sync position, encryption and token are kept; the separate item is stopped first and sync starts only after macOS confirms it is gone. The old entry may stay in Login Items & Extensions until you log out and back in.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Toggle("Connect this Mac to Recall Cloud", isOn: $optIn)
            Text("Connecting enables sync and online retrieval. Unless end-to-end encryption is enabled, agent questions are sent to Cloud to find relevant memories. You can turn online retrieval off after connecting.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button {
                Task { if await cloud.migrate(optIn: optIn) { optIn = false } }
            } label: {
                Label("Move sync into Recall", systemImage: "arrow.right.circle")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(!optIn || cloud.busy)
        }
        .padding(18)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func connectCard(_ snapshot: CloudStatusSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if snapshot.state == "migration-pending" {
                InlineNotice(
                    text: snapshot.error ?? "A previous move did not finish. Nothing is syncing; use Move sync into Recall again.",
                    systemImage: "exclamationmark.triangle.fill",
                    color: .orange
                )
            }
            Text("Connect this Mac")
                .font(.system(size: 14, weight: .semibold))
            HStack(spacing: 10) {
                Button {
                    CloudLinks.openPortal(path: "/connect")
                } label: {
                    Label("Sign in & copy token", systemImage: "arrow.up.right.square")
                }
                Text("Create a token in the portal, then paste it below.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            SecureField("Recall Cloud token", text: $token)
                .textFieldStyle(.roundedBorder)
            DisclosureGroup("End-to-end encryption (optional)") {
                VStack(alignment: .leading, spacing: 6) {
                    SecureField("Passphrase", text: $passphrase)
                        .textFieldStyle(.roundedBorder)
                    Text("Memories are encrypted on this Mac before upload. Use the same passphrase on every device; if you lose it, encrypted memories cannot be recovered.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.top, 6)
            }
            Toggle("Connect this Mac to Recall Cloud", isOn: $optIn)
            Text("Connecting enables sync and online retrieval. Unless end-to-end encryption is enabled, agent questions are sent to Cloud to find relevant memories. You can turn online retrieval off after connecting.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button {
                Task {
                    if await cloud.connect(token: token, passphrase: passphrase, optIn: optIn) {
                        token = ""
                        passphrase = ""
                        optIn = false
                    }
                }
            } label: {
                Label("Connect", systemImage: "icloud.and.arrow.up")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(!optIn || token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || cloud.busy)
        }
        .padding(18)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var features: some View {
        VStack(alignment: .leading, spacing: 12) {
            CloudFeatureRow(
                icon: "arrow.triangle.2.circlepath",
                title: "Two-way sync while connected",
                detail: "Changes and deletions converge every five minutes. Disconnect at any time."
            )
            CloudFeatureRow(
                icon: "network",
                title: "Hosted MCP",
                detail: "Codex, Claude, Cursor, and web agents can query the same synced memory."
            )
            CloudFeatureRow(
                icon: "lock.shield.fill",
                title: "You choose what leaves this Mac",
                detail: "Nothing syncs until you connect. End-to-end encryption is optional and never silently turned off."
            )
        }
        .padding(18)
        .background(.background, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color(nsColor: .separatorColor).opacity(0.45), lineWidth: 1)
        )
    }
}
