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
and host them in a sibling repo that `prebuild-install` can resolve.

## How it works

1. **CI matrix builds prebuilds** in `edihasaj/recall` for every (os, arch,
   node-major) combo we care about:
   - darwin x64, darwin arm64
   - linux x64, linux arm64
   - win32 x64, **win32 arm64** ← the previously missing one
   - node 20, 22, 24
2. **Upload to [`edihasaj/recall-prebuilds`](https://github.com/edihasaj/recall-prebuilds)**,
   tagged by the *better-sqlite3* version (e.g. `v11.10.0`). The workflow's
   publish job uses a fine-grained PAT stored as `RECALL_PREBUILDS_TOKEN`
   secret (default `GITHUB_TOKEN` can't write cross-repo).
3. **Install scripts set the host mirror**: `install.sh` and `install.ps1`
   export `npm_config_better_sqlite3_binary_host_mirror=https://github.com/edihasaj/recall-prebuilds/releases/download`
   before `npm install -g`. `prebuild-install` then constructs the URL as
   `<host>/v<bsq3-version>/<filename>` and downloads our `.node` file with
   no compiler involved.
4. The `windows-11-arm` GitHub-hosted runner makes step 1 free — no
   self-hosted ARM hardware needed.

## Why a sibling repo (not recall's own releases)

`prebuild-install`'s URL template hardcodes the path segment
`/v<package-version>/<filename>` after the host, with no env override. Since
the relevant version is *better-sqlite3*'s (not recall's), hosting tarballs
under recall's own release tag (`v0.7.1`, etc.) makes the URL unresolvable.
The sibling repo lets us name release tags after the better-sqlite3 version,
matching what `prebuild-install` expects.

## Quality preservation

No code change to the storage or retrieval layer. The benchmark stays
green by construction — we're moving the binary, not the algorithm.
