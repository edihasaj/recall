# recall-cloud-sync (vendored)

Bundled so Recall can run optional cloud sync inside its own daemon, without the
separate `Recall Cloud Sync` helper, LaunchAgent or `~/.recall-cloud-sync` install.

## Upstream files (byte-identical copies, do not edit here)

Source: `recall-cloud` repository, `scripts/`, commit `6ad7bfe921ca5d5aab53c95c464664ae57a8d2f3` (2026-10-12).

| File | sha256 |
|---|---|
| `recall-sync.mjs` | `01e5fb2dad66d86ee8c4de126c3efddc4553d86506ce2d7b9c20eb5e6cef5c19` |
| `recall-sync-local.mjs` | `084ad070f468924e5cb9a32c5b6fb7d9d2ea8c3f347838d4360cc1a7cef62e7a` |
| `private-token.mjs` | `4450e12ccf9509d33bf65cb7ef084d059a96898e0bef1adc438b14cf37eb484d` |

To update, copy the three files from `recall-cloud/scripts/`, update the commit and
hashes above, and run `npx vitest run test/cloud-packaging.test.ts`.

## Recall-authored

| File | Purpose |
|---|---|
| `managed-worker.mjs` | Runs the unmodified engine `watch` loop in-process, exits when the daemon's IPC channel closes (including daemon SIGKILL), and bounds every request with a 30s abort signal. |

The engine resolves `better-sqlite3` from the surrounding `node_modules`, so this
directory must stay next to `dist/` and `node_modules/` in the npm package and in
the app's `Runtime`.
