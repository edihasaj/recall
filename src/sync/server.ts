/**
 * Cloud sync server — standalone HTTP service for team memory sharing.
 * Run separately: `node dist/sync-server.js`
 *
 * Endpoints:
 *   POST /api/push    — push local memories to team
 *   POST /api/pull    — pull team memories since version
 *   POST /api/team    — create team
 *   GET  /api/team/:id — get team info
 *   POST /api/team/:id/join — join team
 *   GET  /health
 *
 * Auth: Bearer token in Authorization header (API key).
 * Storage: separate SQLite DB for the sync server.
 */

import { createServer } from "node:http";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const PORT = parseInt(process.env.RECALL_SYNC_PORT ?? "7891", 10);
const DATA_DIR =
  process.env.RECALL_SYNC_DATA_DIR ??
  join(process.env.HOME ?? ".", ".recall", "sync-server");

mkdirSync(DATA_DIR, { recursive: true });
const sqlite = new Database(join(DATA_DIR, "sync.db"));
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

// --- Schema ---

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS team_members (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id),
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at TEXT NOT NULL,
    UNIQUE(team_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    key TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS shared_memories (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id),
    type TEXT NOT NULL,
    text TEXT NOT NULL,
    scope TEXT NOT NULL,
    path_scope TEXT,
    repo TEXT,
    status TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '[]',
    supersedes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    pushed_by TEXT NOT NULL,
    sync_version INTEGER NOT NULL DEFAULT 0,
    origin_id TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_shared_team ON shared_memories(team_id);
  CREATE INDEX IF NOT EXISTS idx_shared_version ON shared_memories(team_id, sync_version);
`);

// --- Prepared statements ---

const stmts = {
  getApiKey: sqlite.prepare("SELECT * FROM api_keys WHERE key = ?"),
  createTeam: sqlite.prepare(
    "INSERT INTO teams (id, name, created_by, created_at) VALUES (?, ?, ?, ?)",
  ),
  getTeam: sqlite.prepare("SELECT * FROM teams WHERE id = ?"),
  addMember: sqlite.prepare(
    "INSERT OR IGNORE INTO team_members (id, team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)",
  ),
  getMembers: sqlite.prepare("SELECT * FROM team_members WHERE team_id = ?"),
  isMember: sqlite.prepare(
    "SELECT * FROM team_members WHERE team_id = ? AND user_id = ?",
  ),
  getMaxVersion: sqlite.prepare(
    "SELECT COALESCE(MAX(sync_version), 0) as max_version FROM shared_memories WHERE team_id = ?",
  ),
  pushMemory: sqlite.prepare(`
    INSERT OR REPLACE INTO shared_memories
    (id, team_id, type, text, scope, path_scope, repo, status, confidence, source, evidence, supersedes, created_at, updated_at, pushed_by, sync_version, origin_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  pullMemories: sqlite.prepare(
    "SELECT * FROM shared_memories WHERE team_id = ? AND sync_version > ? ORDER BY sync_version ASC",
  ),
  createApiKey: sqlite.prepare(
    "INSERT INTO api_keys (key, user_id, created_at) VALUES (?, ?, ?)",
  ),
};

// --- Auth helper ---

function authenticate(
  req: import("node:http").IncomingMessage,
): { user_id: string } | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const key = auth.slice(7);
  const row = stmts.getApiKey.get(key) as any;
  if (!row) return null;
  return { user_id: row.user_id };
}

// --- Body parser ---

function parseBody(req: import("node:http").IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function send(
  res: import("node:http").ServerResponse,
  status: number,
  data: any,
) {
  res.setHeader("Content-Type", "application/json");
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

// --- Server ---

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  try {
    // Health (no auth)
    if (path === "/health" && method === "GET") {
      return send(res, 200, { status: "ok", service: "recall-sync" });
    }

    // Bootstrap: create API key (no auth, first-run only)
    if (path === "/api/bootstrap" && method === "POST") {
      const body = await parseBody(req);
      const key = `rk_${randomUUID().replace(/-/g, "")}`;
      const userId = body.user_id ?? randomUUID();
      stmts.createApiKey.run(key, userId, new Date().toISOString());
      return send(res, 200, { api_key: key, user_id: userId });
    }

    // All other routes require auth
    const auth = authenticate(req);
    if (!auth) {
      return send(res, 401, { error: "unauthorized" });
    }

    // Create team
    if (path === "/api/team" && method === "POST") {
      const body = await parseBody(req);
      const teamId = randomUUID();
      const now = new Date().toISOString();
      stmts.createTeam.run(teamId, body.name ?? "My Team", auth.user_id, now);
      stmts.addMember.run(randomUUID(), teamId, auth.user_id, "owner", now);
      return send(res, 200, { team_id: teamId });
    }

    // Get team
    const teamMatch = path.match(/^\/api\/team\/([^/]+)$/);
    if (teamMatch && method === "GET") {
      const team = stmts.getTeam.get(teamMatch[1]) as any;
      if (!team) return send(res, 404, { error: "team not found" });
      const members = stmts.getMembers.all(teamMatch[1]);
      return send(res, 200, { team, members });
    }

    // Join team
    const joinMatch = path.match(/^\/api\/team\/([^/]+)\/join$/);
    if (joinMatch && method === "POST") {
      const teamId = joinMatch[1];
      const team = stmts.getTeam.get(teamId);
      if (!team) return send(res, 404, { error: "team not found" });
      stmts.addMember.run(
        randomUUID(),
        teamId,
        auth.user_id,
        "member",
        new Date().toISOString(),
      );
      return send(res, 200, { joined: teamId });
    }

    // Push memories
    if (path === "/api/push" && method === "POST") {
      const body = await parseBody(req);
      const teamId = body.team_id;
      if (!teamId) return send(res, 400, { error: "team_id required" });

      const member = stmts.isMember.get(teamId, auth.user_id);
      if (!member) return send(res, 403, { error: "not a team member" });

      const memories: any[] = body.memories ?? [];
      const maxRow = stmts.getMaxVersion.get(teamId) as any;
      let version = (maxRow?.max_version ?? 0) + 1;

      const pushMany = sqlite.transaction(() => {
        for (const mem of memories) {
          const id = mem.id ?? randomUUID();
          stmts.pushMemory.run(
            id,
            teamId,
            mem.type,
            mem.text,
            mem.scope,
            mem.path_scope ?? null,
            mem.repo ?? null,
            mem.status,
            mem.confidence,
            mem.source,
            JSON.stringify(mem.evidence ?? []),
            mem.supersedes ?? null,
            mem.created_at,
            mem.updated_at,
            auth.user_id,
            version,
            mem.origin_id ?? mem.id ?? id,
          );
          version++;
        }
      });
      pushMany();

      return send(res, 200, { pushed: memories.length, version: version - 1 });
    }

    // Pull memories
    if (path === "/api/pull" && method === "POST") {
      const body = await parseBody(req);
      const teamId = body.team_id;
      if (!teamId) return send(res, 400, { error: "team_id required" });

      const member = stmts.isMember.get(teamId, auth.user_id);
      if (!member) return send(res, 403, { error: "not a team member" });

      const sinceVersion = body.since_version ?? 0;
      const rows = stmts.pullMemories.all(teamId, sinceVersion) as any[];

      const memories = rows.map((r) => ({
        ...r,
        evidence: typeof r.evidence === "string" ? JSON.parse(r.evidence) : r.evidence,
      }));

      const maxRow = stmts.getMaxVersion.get(teamId) as any;
      return send(res, 200, {
        memories,
        version: maxRow?.max_version ?? 0,
      });
    }

    send(res, 404, { error: "not found" });
  } catch (err: any) {
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Recall sync server on http://localhost:${PORT}`);
});
