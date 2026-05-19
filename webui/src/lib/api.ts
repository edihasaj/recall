/**
 * Daemon REST client. Always talks to :7890 (the daemon's REST port),
 * never to :7891 (the WebUI's own port — that one only serves bytes
 * and the WebSocket bridge).
 *
 * In `vite dev`, this is proxied via the dev server (`/api/*`).
 * In a production build, it points at the daemon directly.
 */

const DAEMON_BASE =
  import.meta.env.DEV ? "/api" : (import.meta.env.VITE_RECALL_DAEMON_URL ?? "http://localhost:7890");

export interface MemoryItem {
  id: string;
  text: string;
  type: string;
  repo: string | null;
  status: "candidate" | "active" | "rejected" | string;
  scope: string;
  confidence: number;
  source: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ActivityEvent {
  id: string;
  session_id: string | null;
  repo: string | null;
  source: string;
  event_type: string;
  memory_ids: string[] | null;
  created_at: string;
}

export interface SessionRow {
  session_id: string;
  repo: string | null;
  last_at: string;
  event_count: number;
  event_types: string[];
}

export interface ContradictionRow {
  id: string;
  memory_a_id: string;
  memory_b_id: string;
  contradiction_type: string;
  severity: string;
  description: string;
  resolved: boolean;
  detected_at: string;
}

async function getJson<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(`${DAEMON_BASE}${path}`, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${DAEMON_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return res.json() as Promise<T>;
}

// ---- Knowledge graph types ----
export type EntityKind =
  | "file" | "function" | "library" | "tool" | "concept" | "repo_path" | "command" | "url";
export type RelationType =
  | "uses" | "replaces" | "conflicts_with" | "tested_by" | "depends_on" | "references" | "part_of";

export interface EntityRow {
  id: string;
  kind: EntityKind;
  name: string;
  normalized_name: string;
  repo: string | null;
  description: string | null;
  mention_count: number;
  first_seen_memory_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface EntityRelationRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: RelationType;
  source_memory_id: string | null;
  confidence: number;
  created_at: string;
}

export interface GraphStats {
  entities: number;
  relations: number;
}

export interface GraphNeighborsResult {
  root: EntityRow;
  entities: EntityRow[];
  relations: EntityRelationRow[];
  memories_by_entity: Record<string, string[]>;
}

export const api = {
  health: () => getJson<{ status: string; version: string }>("/health"),
  memories: (repo?: string, status?: string, limit = 100) =>
    getJson<{ memories: MemoryItem[] }>("/memories", { repo, status, limit }),
  memory: (id: string) => getJson<MemoryItem>(`/memory/${encodeURIComponent(id)}`),
  activity: (repo?: string, limit = 50) =>
    getJson<{ events: ActivityEvent[] }>("/activity", { repo, limit }),
  sessions: (repo?: string, limit = 50) =>
    getJson<{ sessions: SessionRow[] }>("/sessions", { repo, limit }),
  contradictions: () =>
    getJson<{ contradictions: ContradictionRow[] }>("/contradictions"),
  confirm: (memory_id: string) => postJson<{ success: boolean }>("/confirm", { memory_id }),
  reject: (memory_id: string) => postJson<{ success: boolean }>("/reject", { memory_id }),
  resolveContradiction: (id: string, keep_memory_id: string) =>
    postJson<{ success: boolean }>("/contradictions/resolve", { contradiction_id: id, keep_memory_id }),

  // Knowledge graph
  graphStats: () => getJson<GraphStats>("/graph/stats"),
  graphEntities: (params?: { repo?: string; kind?: string; search?: string; limit?: number }) =>
    getJson<{ count: number; entities: EntityRow[] }>("/graph/entities", params),
  graphRelations: (params?: { repo?: string; limit?: number }) =>
    getJson<{ count: number; relations: EntityRelationRow[] }>("/graph/relations", params),
  graphNeighbors: (entity_id: string, hops = 1) =>
    postJson<GraphNeighborsResult>("/graph/neighbors", { entity_id, hops, include_memories: true }),
  graphMemoryEntities: (memory_id: string) =>
    getJson<{ memory_id: string; entities: EntityRow[] }>(
      `/graph/memory/${encodeURIComponent(memory_id)}`,
    ),
};
