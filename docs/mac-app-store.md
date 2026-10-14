---
summary: Recall's signed sandbox runtime proof, incompatible installer paths, and proposed store architecture.
read_when:
  - Preparing Recall for the Mac App Store
  - Changing daemon ownership, bundled Node signing, agent hooks, or sandbox storage
---

# Mac App Store compatibility

Audited on 14 October 2026. Recall has not been submitted to the Mac App Store.
A development-signed sandbox runtime proof passed, but the current application
installer and agent integration are not a ready store edition.

## Verified runtime proof

A separate staged app used Recall's existing bundle ID `com.edihasaj.recall`,
the Applifyer development certificate, and a new development provisioning
profile. No installed application or running daemon was replaced.

The parent app had App Sandbox and local network client/server entitlements.
Its copied Node executable had sandbox inheritance and hardened-runtime
JavaScript permissions.

| Check | Result |
| --- | --- |
| Execute the bundled Node 22.23.2 as a sandboxed child | Passed |
| Load the bundled native SQLite addon | Passed |
| Create a SQLite table, write a fixture, and read it back | Passed |
| Relaunch the signed parent and retain the earlier SQLite fixture | Passed; the second run observed two rows |
| Execute dynamically created JavaScript | Passed; returned 42 |
| Listen on loopback and call the local HTTP endpoint | Passed |
| Store the fixture in Recall's app container | Passed |
| Launch the same inherited-sandbox Node directly from an outside process | Failed with exit 133 |
| Existing production daemon on port 7890 after verification | Healthy; version 2.0.7 |

The proof's output and staged source are under `/tmp/recall-mas-proof`.
Its database is limited to `Recall/StoreRuntimeProof` inside the app container.
It does not prove ONNX inference, the complete daemon, agent hook delivery,
or store package validation.

## Remaining application changes

| Current behavior | Required store implementation |
| --- | --- |
| Install a LaunchAgent and call `launchctl` | An app-owned bundled process, or an approved bundled background service, with explicit lifecycle and consent. |
| Install a CLI launcher in `~/.local/bin` | Keep executable code in the application bundle. |
| Configure stdio MCP and hooks to launch bundled Node from agents | A local HTTP MCP and hook bridge; the inherited-sandbox executable cannot serve as the existing standalone launcher. |
| Read and write agent home directories automatically | Explicit user-selected folder access and persistent bookmarks, or a manual configuration flow. |
| Store memory and embedding caches under `~/.recall` | Container-aware storage throughout the runtime. `RECALL_DATA_DIR` already covers the database; embedding cache paths still need adaptation. |
| Replace the app through Homebrew or a direct updater | Mac App Store updates, including removing updater executables and disabling their backend endpoints. |
| Enable login behavior on installation | User-controlled login registration in the store edition. |

The current native daemon controller installs the CLI and LaunchAgent in
`macos/RecallApp/Recall/DaemonController.swift`. Agent configuration is managed
in `src/setup/local.ts`. The embedding cache currently derives its location
from `homedir()` in `src/embeddings/cache.ts`.

The proposed store architecture keeps the local memory compiler and native
database, runs the service while Recall owns it, and connects agents through
local HTTP. Folder access and integration setup must be presented explicitly
to the user. Those onboarding and connection changes need a defined store
edition scope before packaging.

Recall's local product is free; this work does not require adding payments.

## Registered development identity

- Bundle ID registration: `ZYP72V89B5`.
- Bundle identifier: `com.edihasaj.recall`.
- Team: `T8J48M4QVY`.
- Profile: `Recall Mac Development 2026-10`.
- Profile UUID: `7ca4c858-8a6c-4a17-97e1-2ba2fbbc04fc`.
- Development certificate: `KCK235B5SP`.

The profile is for development verification, not store distribution.
The signed proof contains no change to the production Recall release workflow.

## Apple sources

- [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/),
  particularly 2.4.5(i–iii), 2.4.5(vii), and 2.5.2.
- [Protecting user data with App Sandbox](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox).
- [Embedding a command-line tool in a sandboxed app](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app).
