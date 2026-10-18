import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import type { RecallDb } from "../db/client.js";
import { memories } from "../db/schema.js";
import { recordAudit } from "../audit/trail.js";
import { upsertMemoryFtsRow } from "../vector/sqlite-fts.js";

const MAX_DOCUMENT_BYTES = 128 * 1024;
const MAX_DOCUMENT_CODEPOINTS = 20_000;
const MAX_REPO_LENGTH = 255;
const MAX_SOURCE_REF_LENGTH = 2_000;
const HARNESS2_DEDUPE_PREFIX = "harness2\u001fsha256:";

export interface Harness2ExperienceOptions {
  repo: string;
  sourceRef?: string;
}

export interface Harness2CloudImport {
  provider: "harness2";
  project: string;
  content: string;
  sourceRef: string | null;
}

export interface Harness2ExperiencePreview extends Harness2CloudImport {
  digest: string;
  id: string;
  candidate: {
    type: "gotcha";
    scope: "repo";
    status: "candidate";
    confidence: 0.4;
    source: "tool_outcome";
    autoInject: false;
  };
  cloudImport: Harness2CloudImport;
}

export interface Harness2ImportResult {
  id: string;
  created: boolean;
  /** The retained record, which can differ from the candidate preview on duplicate imports. */
  memory: typeof memories.$inferSelect;
  preview: Harness2ExperiencePreview;
}

/** Normalize the document before hashing or storing it. */
export function normalizeHarness2Experience(text: string): string {
  return text.replace(/^\uFEFF/u, "").replace(/\r\n?|\n/g, "\n").trim();
}

/**
 * Turn one complete Harness2 EXPERIENCE.md document into one candidate.
 * This is pure so callers can preview an import without opening a database.
 */
export function previewHarness2Experience(
  text: string,
  options: Harness2ExperienceOptions,
): Harness2ExperiencePreview {
  const repo = validateRepo(options.repo);
  const sourceRef = validateSourceRef(options.sourceRef);
  validateRawDocument(text);
  const content = normalizeHarness2Experience(text);
  validateDocument(content);

  const digest = sha256(`${repo}\n${content}`);
  const id = uuidFromDigest(digest);
  const cloudImport: Harness2CloudImport = {
    provider: "harness2",
    project: repo,
    content,
    sourceRef,
  };

  return {
    ...cloudImport,
    digest,
    id,
    candidate: {
      type: "gotcha",
      scope: "repo",
      status: "candidate",
      confidence: 0.4,
      source: "tool_outcome",
      autoInject: false,
    },
    cloudImport,
  };
}

/**
 * Read one bounded, regular EXPERIENCE.md file without following symlinks.
 * The caller supplies a sourceRef separately so copied files stay idempotent.
 */
export function readHarness2Experience(
  file: string,
  options: Harness2ExperienceOptions,
): Harness2ExperiencePreview {
  // A checked-in file remains traceable without making its path part of the
  // content digest. An explicit Harness2 reference still takes precedence.
  const sourceRef = options.sourceRef ?? resolve(file);
  validateSourceRef(sourceRef);
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
  let fd: number | undefined;
  try {
    fd = openSync(file, flags);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Harness2 import requires a regular file.");
    if (stat.size > MAX_DOCUMENT_BYTES) {
      throw new Error(`Harness2 EXPERIENCE.md exceeds ${MAX_DOCUMENT_BYTES} bytes.`);
    }

    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== stat.size) throw new Error("Harness2 EXPERIENCE.md changed while it was read.");

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error("Harness2 EXPERIENCE.md must be valid UTF-8.");
    }
    return previewHarness2Experience(text, { ...options, sourceRef });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Atomically insert this exact document, or return its retained prior record.
 * Dedupe is the digest-derived UUID, so rejected records and copied paths stay
 * idempotent even though ordinary rejection clears a memory's dedupe key.
 */
export function importHarness2Experience(
  db: RecallDb,
  preview: Harness2ExperiencePreview,
): Harness2ImportResult {
  assertPreviewIntegrity(preview);

  const { created, memory } = db.$client.transaction(() => {
    const existing = db.select()
      .from(memories)
      .where(eq(memories.id, preview.id))
      .get();
    if (existing) return { created: false, memory: existing };

    const now = new Date().toISOString();
    const sourceFile = preview.sourceRef ?? "EXPERIENCE.md";
    const generatedContext = `<agent-response> experimental Harness2 EXPERIENCE.md import; sourceRef=${sourceFile}; sha256=${preview.digest}`;
    db.insert(memories).values({
      id: preview.id,
      type: "gotcha",
      text: preview.content,
      scope: "repo",
      path_scope: null,
      repo: preview.project,
      status: "candidate",
      confidence: 0.4,
      source: "tool_outcome",
      evidence: [
        {
          type: "review_feedback",
          reported_by_user: false,
          reviewer: "harness2",
          timestamp: now,
          context: generatedContext,
        },
        { type: "repo_scan", file: sourceFile, timestamp: now },
      ] as any,
      capture_context: null,
      note: null,
      supersedes: null,
      dedupe_key: `${HARNESS2_DEDUPE_PREFIX}${preview.digest}`,
      created_at: now,
      updated_at: now,
      last_validated_at: null,
      last_injected_at: null,
      injection_count: 0,
      override_count: 0,
      repetition_count: 0,
      auto_inject: false,
    }).run();

    const inserted = db.select().from(memories).where(and(
      eq(memories.id, preview.id),
      eq(memories.repo, preview.project),
    )).get();
    if (!inserted) throw new Error("Harness2 import did not retain its inserted candidate.");
    upsertMemoryFtsRow(db, inserted);
    recordAudit(db, preview.id, "created", "harness2", "imported EXPERIENCE.md");
    return { created: true, memory: inserted };
  }).immediate();

  return { id: memory.id, created, memory, preview };
}

function validateRepo(value: string): string {
  const repo = value?.trim();
  if (!repo) throw new Error("Harness2 import requires --repo.");
  if (codePointLength(repo) > MAX_REPO_LENGTH) {
    throw new Error(`Harness2 repo must be at most ${MAX_REPO_LENGTH} characters.`);
  }
  if (repo.includes("\0")) throw new Error("Harness2 repo must not contain NUL.");
  if (/[\r\n]/u.test(repo)) throw new Error("Harness2 repo must be a single line.");
  return repo;
}

function validateSourceRef(value: string | undefined): string | null {
  if (value == null) return null;
  const sourceRef = value.trim();
  if (!sourceRef) return null;
  if (codePointLength(sourceRef) > MAX_SOURCE_REF_LENGTH) {
    throw new Error(`Harness2 sourceRef must be at most ${MAX_SOURCE_REF_LENGTH} characters.`);
  }
  if (sourceRef.includes("\0")) throw new Error("Harness2 sourceRef must not contain NUL.");
  return sourceRef;
}

function validateDocument(content: string) {
  if (!content) throw new Error("Harness2 EXPERIENCE.md must not be empty.");
  if (content.includes("\0")) throw new Error("Harness2 EXPERIENCE.md must not contain NUL.");
  if (codePointLength(content) > MAX_DOCUMENT_CODEPOINTS) {
    throw new Error(`Harness2 EXPERIENCE.md must be at most ${MAX_DOCUMENT_CODEPOINTS} Unicode code points.`);
  }
  if (Buffer.byteLength(content, "utf8") > MAX_DOCUMENT_BYTES) {
    throw new Error(`Harness2 EXPERIENCE.md exceeds ${MAX_DOCUMENT_BYTES} bytes.`);
  }
}

function validateRawDocument(text: string) {
  if (text.includes("\0")) throw new Error("Harness2 EXPERIENCE.md must not contain NUL.");
  if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) {
    throw new Error(`Harness2 EXPERIENCE.md exceeds ${MAX_DOCUMENT_BYTES} bytes.`);
  }
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      throw new Error("Harness2 EXPERIENCE.md must not contain an unpaired UTF-16 surrogate.");
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error("Harness2 EXPERIENCE.md must not contain an unpaired UTF-16 surrogate.");
    }
  }
}

function assertPreviewIntegrity(preview: Harness2ExperiencePreview) {
  const expected = previewHarness2Experience(preview.content, {
    repo: preview.project,
    sourceRef: preview.sourceRef ?? undefined,
  });
  if (preview.digest !== expected.digest || preview.id !== expected.id) {
    throw new Error("Harness2 preview digest does not match its content.");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function uuidFromDigest(digest: string): string {
  const bytes = Buffer.from(digest.slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // name-based UUID version bits
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant bits
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}
