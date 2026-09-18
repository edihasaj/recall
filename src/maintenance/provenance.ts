import { eq } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { memories } from "../db/schema.js";
import { getMemory, queryMemories } from "../models/memory.js";
import { hasNonDurableProvenance } from "../capture/provenance.js";
import { recordAuditWithSnapshot } from "../audit/trail.js";
import { queueMemoryEmbeddingSync } from "../embeddings/embeddings.js";

export function quarantineGeneratedMemories(db: RecallDb, apply = false): string[] {
  const ids: string[] = [];
  for (const memory of queryMemories(db, {})) {
    if (memory.status === "rejected" || !hasNonDurableProvenance(memory)) continue;
    if (memory.status === "candidate" && !memory.auto_inject && memory.confidence <= 0.35 && memory.repetition_count === 0) continue;
    ids.push(memory.id);
    if (!apply) continue;
    db.$client.transaction(() => {
      db.update(memories).set({ status: "candidate", auto_inject: false, confidence: Math.min(memory.confidence, 0.35), repetition_count: 0, updated_at: new Date().toISOString() })
        .where(eq(memories.id, memory.id)).run();
      recordAuditWithSnapshot(db, memory.id, "demoted", "maintenance:provenance",
        "Quarantined: generated correction evidence or an explicitly task-limited rule.",
        memory, getMemory(db, memory.id) ?? null);
    })();
    queueMemoryEmbeddingSync(db, memory.id);
  }
  return ids;
}
