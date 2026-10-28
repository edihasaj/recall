# recall-cloud-sync (vendored)

Bundled so Recall can run optional cloud sync inside its own daemon, without the
separate `Recall Cloud Sync` helper, LaunchAgent or `~/.recall-cloud-sync` install.

## Upstream snapshot and reviewed backports

Source: `recall-cloud` repository, `scripts/`, commit `6ad7bfe921ca5d5aab53c95c464664ae57a8d2f3` (2026-10-12).

The two sync modules include the October 28, 2026 privacy-verification backport
from `recall-cloud/scripts`, commit `218a03d`: transactional failure on invalid encrypted payloads,
key verification before upload, and a full encrypted pull on watcher restart.
The upload projection also backports optional note-column selection from
upstream `13b0b58` without importing unrelated installer and outcome changes.
The token module remains byte-identical to the original snapshot. Maintain
changes upstream first, then apply the focused backport; do not develop a second
sync engine here.

| File | sha256 |
|---|---|
| `recall-sync.mjs` | `4c1404f91144e03a6d75038776ec2c976f696a89cfcc560d086d2540593b2223` |
| `recall-sync-local.mjs` | `d2b4d1172fc1e39be52fac1eb4fc8b64cb5ae83969e70944188fde4406c7cadb` |
| `private-token.mjs` | `4450e12ccf9509d33bf65cb7ef084d059a96898e0bef1adc438b14cf37eb484d` |

To refresh the complete snapshot, stage the upstream module graph together,
including any new relative imports, update the commit and hashes above, and
run `npx vitest run test/cloud-packaging.test.ts`. For a focused backport, keep
its source and scope here. The upstream `scripts/recall-sync-private.test.mjs`
also runs against this engine by setting `RECALL_SYNC_ENGINE` to its absolute
path, exercising actual HTTP push/pull, restore, key failure and retry safety.

## Recall-authored

| File | Purpose |
|---|---|
| `managed-worker.mjs` | Runs the unmodified engine `watch` loop in-process, exits when the daemon's IPC channel closes (including daemon SIGKILL), and bounds every request with a 30s abort signal. |

The engine resolves `better-sqlite3` from the surrounding `node_modules`, so this
directory must stay next to `dist/` and `node_modules/` in the npm package and in
the app's `Runtime`.
