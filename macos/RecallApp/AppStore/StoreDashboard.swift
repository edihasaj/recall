import AppKit
import ServiceManagement
import SwiftUI
import WebKit

struct StoreDashboard: View {
    @ObservedObject var runtime: StoreRuntime
    @State private var agent = "codex"
    @State private var memoryText = ""
    @State private var repository = ""
    @State private var saveStatus: String?

    var body: some View {
        VStack(spacing: 0) {
            TabView {
                Group {
                    if runtime.ready {
                        StoreWebView(url: runtime.dashboardURL)
                    } else {
                        VStack(spacing: 14) {
                            Image("AppIcon").resizable().frame(width: 72, height: 72)
                            Text("Recall").font(.title)
                            if runtime.error == nil { ProgressView() }
                            Text(runtime.error ?? runtime.status)
                            Button("Start local memory") { runtime.start() }
                            Button("Open service log") { runtime.openLog() }
                        }.frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }.tabItem { Label("Memory", systemImage: "brain") }
                newMemory.tabItem { Label("Add Memory", systemImage: "plus.circle") }
                connections.tabItem { Label("Connect Agents", systemImage: "link") }
                folders.tabItem { Label("Repositories", systemImage: "folder") }
                StorePreferences(runtime: runtime).tabItem { Label("Preferences", systemImage: "gearshape") }
            }
            Divider()
            HStack {
                Circle().fill(runtime.ready ? .green : .orange).frame(width: 7, height: 7)
                Text(runtime.status).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text("Memory is stored on this Mac").font(.caption).foregroundStyle(.secondary)
            }.padding(.horizontal, 18).padding(.vertical, 9)
        }
    }

    private var newMemory: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Remember a rule").font(.title2.bold())
            Text("Write a preference or project rule your coding agent should keep using.")
            TextField("Repository, such as owner/project (optional)", text: $repository)
            TextEditor(text: $memoryText).frame(minHeight: 140, maxHeight: 220).border(.quaternary)
            Text("Leave the repository empty to apply the rule to every project.")
                .font(.callout).foregroundStyle(.secondary)
            Button("Save memory") {
                Task {
                    do {
                        _ = try await runtime.request("/store/memory", body: [
                            "text": memoryText, "repo": repository,
                        ])
                        memoryText = ""
                        saveStatus = "Saved. Your connected agent can now retrieve this rule."
                    } catch { saveStatus = error.localizedDescription }
                }
            }.disabled(!runtime.ready || memoryText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            if let saveStatus { Text(saveStatus).font(.callout) }
            Spacer()
        }.padding(32)
    }

    private var connections: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Connect your coding agent").font(.title2.bold())
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
            }.padding(32).frame(maxWidth: 850, alignment: .leading)
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

    private var folders: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Choose your repositories").font(.title2.bold())
            Text("Recall can learn from files in the folders you choose. Folder access is read-only. Adding or removing a folder restarts the local service to apply its permissions.")
            Button("Add repository folder…") { runtime.chooseFolder() }
            List(runtime.folders, id: \.path) { folder in
                HStack {
                    Label(folder.lastPathComponent, systemImage: "folder")
                    Text(folder.path).foregroundStyle(.secondary)
                    Spacer()
                    Button("Remove") { runtime.removeFolder(folder) }
                }
            }
        }.padding(32)
    }

    private func copy(_ string: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
    }
}

struct StorePreferences: View {
    @ObservedObject var runtime: StoreRuntime
    @AppStorage("store.launchAtLogin") private var launchAtLogin = false
    @State private var preferenceError: String?

    var body: some View {
        Form {
            Toggle("Launch at login", isOn: $launchAtLogin)
                .onChange(of: launchAtLogin) { _, enabled in
                    do {
                        if enabled && SMAppService.mainApp.status == .notRegistered {
                            try SMAppService.mainApp.register()
                        } else if !enabled && SMAppService.mainApp.status != .notRegistered {
                            try SMAppService.mainApp.unregister()
                        }
                        preferenceError = nil
                    } catch { preferenceError = error.localizedDescription }
                }
            if let preferenceError { Text(preferenceError).foregroundStyle(.red) }
            Text("Closing the window leaves Recall in the menu bar. Quit Recall to stop its local memory service.")
            Button("Restart local memory") { Task { await runtime.restart() } }
            Button("Open service log") { runtime.openLog() }
            Text("Updates are delivered through the Mac App Store.")
            Link("Support", destination: URL(string: "https://github.com/edihasaj/recall/issues")!)
            Link("Privacy policy", destination: URL(string: "https://github.com/edihasaj/recall/blob/main/docs/privacy.md")!)
            Text("Recall \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")")
                .foregroundStyle(.secondary)
        }.formStyle(.grouped).padding(24)
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
