import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, initStandaloneDb } from "../src/db/client.js";
import { ensureDailyBackup } from "../src/backups/snapshot.js";
import { runReliabilityProbe } from "../src/reliability/probe.js";
import { listActivityEvents } from "../src/models/activity.js";

afterEach(() => {
  closeDb();
  delete process.env.RECALL_EMBEDDINGS_DISABLED;
});

describe("reliability probe", () => {
  it("checks the live database, latest backup, and disposable canary", async () => {
    const root = mkdtempSync(join(tmpdir(), "recall-probe-"));
    const path = join(root, "recall.db");
    const db = initStandaloneDb(path);
    ensureDailyBackup({ dbPath: path });

    const result = await runReliabilityProbe(db, { real_embeddings: false });
    expect(result).toMatchObject({
      ok: true,
      database_integrity: true,
      backup_integrity: true,
      canary_ok: true,
    });
    const events = listActivityEvents(db, { event_type: "signal" });
    expect(events).toHaveLength(1);
    expect(events[0].request).toMatchObject({ name: "reliability_probe" });
  });
});
