---
summary: How recall ships native SQLite bindings across every platform without forcing users to install Python + MSVC.
read_when:
  - Changing native SQLite dependencies or Windows vector support
---

# Storage strategy

Recall's storage and vector search depend on two native modules:

- `better-sqlite3` — synchronous SQLite, used by the daemon and CLI.
- `sqlite-vec` — vector index extension, selected through `src/vector/native-extension.ts`.

`better-sqlite3` uses `prebuild-install` for common platforms,
but **does not publish `win32-arm64` prebuilds** as of v11.10.
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

The better-sqlite3 mirror changes binary delivery without changing the storage API.

## Windows ARM64 vector extension

Recall 1.4.5 uses the pinned optional package `@photostructure/sqlite-vec@2.0.1`
only when Node reports `win32` and `arm64`. Windows x64, macOS, and Linux keep
the upstream `sqlite-vec` loader. The fork bundles an ARM64 DLL; the native
prebuild workflow still builds only better-sqlite3.

The loader first opens an in-memory SQLite connection, loads the DLL, and
queries `vec_version()`. A missing package, missing DLL, or failed load keeps
the daemon in lexical mode with the reason in `/health`. That result is cached
until restart so repeated requests do not keep attempting a broken load.
Installing with `--omit=optional` therefore leaves Windows ARM64 in lexical mode.

No database reset or schema migration is required. Compatibility tests cover
both memory and history indexes, repository filtering, writes, reopening, and
old-library rollback. Windows CI runs native queries on x64 and ARM64, plus an
opt-in real Nomic embedding test that persists and reopens its synthetic data.
Run that model test locally with `RECALL_TEST_REAL_EMBEDDINGS=true` and
`npx vitest run test/native-embedding-e2e.test.ts`; it downloads about 140 MB
on the first run. Its ranking assertion uses an explicit score threshold so
the test checks native retrieval independently of product relevance policy.
