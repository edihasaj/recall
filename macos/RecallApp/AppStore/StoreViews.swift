import AppKit
import SwiftUI
import WebKit

/// The direct app's Daemon pane, driving the app-owned service, plus the two
/// things only a sandboxed edition needs: repository folder access and the
/// local agent connection.
struct StoreServiceTab: View {
    @ObservedObject var controller: DaemonController
    @ObservedObject var webui: WebUIController
    @ObservedObject private var runtime: StoreRuntime
    @State private var agent = "codex"

    init(controller: DaemonController, webui: WebUIController) {
        self.controller = controller
        self.webui = webui
        self.runtime = controller.runtime
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            GroupBox("Service") {
                VStack(alignment: .leading, spacing: 10) {
                    LabeledValue(label: "Status", value: controller.launchdState)
                    LabeledValue(label: "Health", value: controller.healthText)
                    LabeledValue(label: "Data", value: controller.dataDir)
                    LabeledValue(label: "Logs", value: controller.logDir)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
            }

            GroupBox("Lifecycle") {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 10) {
                        Button("Start") { controller.startDaemon() }
                            .buttonStyle(.borderedProminent)
                        Button("Stop") { controller.stopDaemon() }
                        Button("Restart") { controller.restartDaemon() }
                    }
                    HStack(spacing: 10) {
                        Button("Open Data Folder") { controller.openDataDir() }
                        Button("Open Logs") { controller.openLogDir() }
                        Spacer()
                        Button("Refresh") { controller.refresh(); webui.refresh() }
                    }
                }
                .padding(.top, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            folders
            connections

            if let lastError = controller.lastError, !lastError.isEmpty {
                Text(lastError)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.red)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private var folders: some View {
        GroupBox("Repositories") { VStack(alignment: .leading, spacing: 14) {
            Text("Recall can learn from files in the folders you choose. Folder access is read-only. Adding or removing a folder restarts the local service to apply its permissions.")
            Button("Add repository folder…") { runtime.chooseFolder() }
            if runtime.folders.isEmpty {
                Text("No folders chosen yet.").foregroundStyle(.secondary)
            } else {
                ForEach(runtime.folders, id: \.path) { folder in
                    HStack {
                        Label(folder.lastPathComponent, systemImage: "folder")
                        Text(folder.path).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        Spacer()
                        Button("Remove") { runtime.removeFolder(folder) }
                    }
                }
            }
        }.fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4) }
    }


    private var connections: some View {
        GroupBox("Connect agents") {
            VStack(alignment: .leading, spacing: 16) {
                                Text("Keep Recall open while your agent uses its local memory. Add the connection below, then restart your agent.")
                Text("Choose your repository folders under Repositories so Recall can identify projects and read their rules for automatic session context.")
                Picker("Agent", selection: $agent) {
                    Text("Codex").tag("codex")
                    Text("Claude Code").tag("claude-code")
                    Text("Other MCP clients").tag("other")
                }.pickerStyle(.segmented)
                let command = agent == "codex"
                    ? "codex mcp add recall-store --url \(runtime.origin)/mcp"
                    : agent == "claude-code"
                        ? "claude mcp add --transport http --scope user recall-store \(runtime.origin)/mcp"
                        : "\(runtime.origin)/mcp"
                GroupBox("Local MCP connection") {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(command).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                        Button("Copy connection") { copy(command) }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                }
                Text("Automatic session memory").font(.headline)
                Text("Optional hooks let Recall receive corrections and provide context at session start and on each prompt. Merge the hook configuration into your agent’s settings. In Codex, review and trust the hooks with /hooks.")
                if agent != "other" {
                    Button("Copy hook configuration") { copy(hookConfiguration) }
                    Text(agent == "codex" ? "Use hooks.json in your Codex profile and enable codex_hooks in its features."
                         : "Merge into ~/.claude/settings.json.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                Text("Use one Recall installation for each agent connection. This store edition has its own memory; it does not import or replace the direct-download edition automatically.")
                    .font(.callout).foregroundStyle(.secondary)
            }.fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
        }
    }

    private var hookConfiguration: String {
        var hooks: [String: Any] = [:]
        for event in ["SessionStart", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "Stop"] {
            let command = "/usr/bin/curl --silent --show-error --fail --max-time 15 -H 'Content-Type: application/json' --data-binary @- \(runtime.origin)/hook/agent/\(agent)/\(event) || true"
            hooks[event] = [["hooks": [["type": "command", "command": command]]]]
        }
        let data = try? JSONSerialization.data(withJSONObject: ["hooks": hooks], options: [.prettyPrinted, .sortedKeys])
        return data.map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    }


    private func copy(_ string: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
    }
}

/// The dashboard fills the detail area, the way the browser dashboard does in the direct app.
struct StoreDashboardView: View {
    @ObservedObject var webui: WebUIController

    var body: some View {
        if webui.running {
            StoreWebView(url: webui.dashboardURL)
        } else {
            VStack(spacing: 14) {
                ProgressView()
                Text(webui.statusText).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

struct StoreWebView: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.load(URLRequest(url: url))
        return view
    }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        let url: URL
        init(url: URL) { self.url = url }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let target = action.request.url else { return .cancel }
            if target.host == url.host && target.port == url.port { return .allow }
            if action.navigationType == .linkActivated, ["https", "http"].contains(target.scheme) {
                NSWorkspace.shared.open(target)
            }
            return .cancel
        }
    }
}
