---
summary: How recall ships native SQLite bindings across every platform without forcing users to install Python + MSVC.
---

# Storage strategy

Recall's storage and vector search depend on two native modules:

- `better-sqlite3` — synchronous SQLite, used by the daemon and CLI.
- `sqlite-vec` — vector index extension; load via `sqliteVec.load(sqlite)`.

Both ship prebuilt binaries via `prebuild-install` for the common platforms,
but **`better-sqlite3` does not publish `win32-arm64` prebuilds** as of v11.10.
A normal `npm install -g @edihasaj/recall` on Windows ARM hits the
node-gyp fallback, which needs Python + Visual Studio Build Tools the user
doesn't have. Result: install fails on a fresh Windows-ARM box.

Same problem will eventually bite us on linux-arm64-musl, freebsd, and any
future Node ABI that the upstream maintainers haven't republished for.

## The decision

Stay on `better-sqlite3` + `sqlite-vec` — the storage layer that scored
**R@5 = 97.4 %** on LongMemEval-S (vs `agentmemory` BM25+vector at 95.2 %).
Migrating to libsql would mean rewriting the vector pipeline (libsql uses
its own native vector type instead of `sqlite-vec`'s virtual tables), then
re-running the full benchmark to confirm no regression. Not worth the risk.

Instead: **own the missing prebuilds** via `.github/workflows/native-prebuilds.yml`
and ship them with recall.

## How it works

1. **CI matrix builds prebuilds** for every (os, arch, node-major) combo we
   care about:
   - darwin x64, darwin arm64
   - linux x64, linux arm64
   - win32 x64, **win32 arm64** ← the previously missing one
   - node 20, 22, 24
2. **Upload to the GitHub Release** for each tag. `prebuild-install` looks
   here by default, so the standard `npm install` flow on the user's machine
   downloads the matching `.node` file with no compiler involved.
3. The `windows-11-arm` GitHub-hosted runner makes step 1 free — no
   self-hosted ARM hardware needed.

## Quality preservation

No code change to the storage or retrieval layer. The benchmark stays
green by construction — we're moving the binary, not the algorithm.
