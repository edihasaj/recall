---
summary: Recall's sandboxed Mac App Store edition, HTTP agent connections, signing, and release verification.
read_when:
  - Preparing Recall for the Mac App Store
  - Changing daemon ownership, bundled Node signing, agent hooks, or sandbox storage
---

# Mac App Store

Recall's Mac App Store record is `6822790969`, titled **Recall: Coding Memory**.
The bundle identifier remains `com.edihasaj.recall`, registered ID `ZYP72V89B5`,
team `T8J48M4QVY`. The initial store version is **2.0.7 (1)** for Apple Silicon
and macOS 15+. Pricing is free in all 175 territories, including future
territories. App Privacy is published as **Data Not Collected**.

## Architecture

`macos/RecallApp/project-app-store.yml` builds the native store shell in
`macos/RecallApp/AppStore`. It embeds the normal memory compiler, database,
MCP server, and web dashboard with a standalone Node 22 executable.

```text
Recall.app (App Sandbox)
  ├─ native memory, repository, connection, and preference screens
  ├─ app-owned Node child → SQLite, graph, local model cache
  ├─ local daemon :7892 → MCP + raw agent hook bridge
  └─ dashboard :7893 → embedded WKWebView
                         ↑
              configured agents on this Mac
```

The service receives a minimal environment with an explicit container data
path and `RECALL_EMBEDDING_CACHE_DIR`. It inherits the parent's sandbox and
selected repository permissions. The app checks its own instance identifier
before using an endpoint. Startup retries are bounded; stopping or quitting
terminates the owned child. Closing the window retains the service and menu
bar item, and Open Recall restores the same window.

There is no LaunchAgent, external CLI installation, Homebrew updater, or
background process left running after Quit. Launch at login defaults to off
and uses `SMAppService.mainApp` when enabled by the user. Developer-owned
telemetry and cloud dispatch are not enabled in this edition.

Repositories are selected through `NSOpenPanel`, with read-only security-scoped
bookmarks restored at startup. Changing the selected folders restarts the child
so the new sandbox grants apply. Repository identification reads Git metadata
rather than requiring an external Git installation.

The inherited-sandbox Node executable cannot be launched directly by an
outside agent. MCP and optional lifecycle hooks therefore use local HTTP.
The Connect Agents screen copies connection commands and hook JSON; it does
not rewrite another app's settings. Review hook trust in the agent itself.

The store database is separate from the direct-download edition's `~/.recall`.
Existing memories are not imported automatically. Use one Recall connection
per agent to avoid duplicate capture from two installations.

## Agent connections

The app provides these commands in Connect Agents:

```bash
codex mcp add recall-store --url http://127.0.0.1:7892/mcp
claude mcp add --transport http --scope user recall-store http://127.0.0.1:7892/mcp
```

Other MCP clients use the same local HTTP URL. Keep Recall running while the
agent uses its memory. Choose repository folders before using automatic session
context, so Recall can resolve the project and read its rules.

Optional hooks call `/hook/agent/<codex|claude-code>/<event>` using system curl
and send the agent's raw hook JSON on stdin. Supported events are SessionStart,
UserPromptSubmit, PostToolUse, PostToolUseFailure, Stop, and SessionEnd.
Startup and prompt responses return the agent's `hookSpecificOutput` envelope;
tool failures retain their failure status. Hook commands have a deadline and
fail without blocking the agent if Recall is closed.

The Add Memory screen saves explicitly confirmed rules through the store-only
`POST /store/memory` endpoint. A repository is optional; an empty repository
makes a rule global. The dashboard reviews memories, graph relationships,
sessions, activity, and contradictions without requiring a coding agent.

`GET /health` reports the optional service `instance_id`. `GET /update` reports
`managed_by: mac-app-store` in this distribution instead of checking the
external download feed. Dashboard HTML publishes its owning daemon's local
port so test, store, and direct installations do not connect to each other.

## Build and verify

1. Install the existing development and distribution profiles through Apple's
   API, then unlock the dedicated team signing keychain. Profile names are
   **Recall Mac Development 2026-10** and **Recall Mac App Store 2026-10**.
2. Run `scripts/build-app-store.sh`. Set `RECALL_MAS_CONFIGURATION=Debug` for a
   development-signed archive. `RECALL_NODE_PATH` must point to a standalone
   Node 22 executable; Homebrew's executable depends on external libraries and
   is rejected. The default source is the installed direct app's copied Node.
3. The script builds and stages production dependencies, signs native modules
   and the inheriting Node executable, archives the app, verifies signatures,
   and creates a signed PKG for Release. It never replaces an installed app.
4. Generate the store project and run `RecallStoreTests` in the signed Debug
   host. The external MCP test requires the matching standalone SDK client
   while its fixture service is listening. See the private release runbook.
5. Export native XCTest screenshot attachments, frame them with
   `scripts/frame-store-screenshots.py`, and inspect the pixels. Listing text
   and 1440×900 images live under `macos/RecallApp/AppStore/listing`.
6. Validate and upload with `xcrun altool`, wait for a `VALID` Mac build, then
   attach assets and submit through the private manager release helper.

Credentials come from the shared Apple signing skill and 1Password inside a
named tmux session. Store packages use Mac App Distribution and Mac Installer
Distribution, not Developer ID notarization. The shared keychain is
`~/Library/Keychains/chirpgo-mas.keychain-db`.

## Verification on 14 October 2026

- TypeScript checks, CLI/dashboard builds, and **915 JavaScript tests** passed;
  three existing optional tests were skipped.
- Four signed sandbox desktop tests passed: window close/reopen, an external
  MCP client retrieving a stored rule, native dashboard rendering, and memory
  persistence plus hook injection across service restart and shutdown.
- The standalone external SDK client connected to the HTTP MCP server and
  retrieved the expected memory from the fixture database.
- Screenshots were captured from the live sandboxed dashboard with fixture
  memories, rather than a mockup.

Evidence is under `/tmp/recall-mas-proof`. These checks do not establish
read access to every external repository or a real ONNX inference benchmark.
The installed direct-download app and its daemon on port 7890 remain separate.

The public privacy policy is [privacy.md](privacy.md). It explains that connected
agents receive selected context and may process it under their own settings.
