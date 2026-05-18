import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from "reactflow";
import "reactflow/dist/style.css";
import { api, type EntityKind, type EntityRow, type EntityRelationRow } from "../lib/api";

const KIND_COLORS: Record<EntityKind, string> = {
  file: "#7aa2f7",
  function: "#bb9af7",
  library: "#f0c674",
  tool: "#9ece6a",
  command: "#a9a9a9",
  concept: "#7dcfff",
  repo_path: "#e0af68",
  url: "#f7768e",
};

const RELATION_COLORS: Record<string, string> = {
  uses: "#9ece6a",
  replaces: "#f7768e",
  conflicts_with: "#ef6f6c",
  tested_by: "#7dcfff",
  depends_on: "#bb9af7",
  references: "#a9a9a9",
  part_of: "#f0c674",
};

export function GraphPage() {
  const [repo, setRepo] = useState("");
  const [kind, setKind] = useState<EntityKind | "">("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const stats = useQuery({ queryKey: ["graph", "stats"], queryFn: () => api.graphStats() });
  const entities = useQuery({
    queryKey: ["graph", "entities", repo, kind, search],
    queryFn: () =>
      api.graphEntities({
        repo: repo || undefined,
        kind: kind || undefined,
        search: search || undefined,
        limit: 150,
      }),
  });
  const neighbors = useQuery({
    queryKey: ["graph", "neighbors", selectedId],
    queryFn: () => api.graphNeighbors(selectedId!, 2),
    enabled: selectedId !== null,
  });

  const { nodes, edges } = useMemo(() => {
    const list = entities.data?.entities ?? [];
    return buildEntityLayout(list, neighbors.data?.relations ?? [], selectedId);
  }, [entities.data, neighbors.data, selectedId]);

  const handleNodeClick: NodeMouseHandler = (_, node) => {
    setSelectedId(node.id);
  };

  return (
    <div>
      <header className="page-header">
        <div>
          <h1 className="page-title">Knowledge graph</h1>
          <p className="page-subtitle">
            {stats.data
              ? `${stats.data.entities} entities · ${stats.data.relations} relations`
              : "loading…"}
          </p>
        </div>
      </header>

      <div className="toolbar">
        <input
          className="input"
          placeholder="repo filter"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
        />
        <select
          className="select"
          value={kind}
          onChange={(e) => setKind(e.target.value as EntityKind | "")}
        >
          <option value="">all kinds</option>
          {Object.keys(KIND_COLORS).map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        <input
          className="input"
          placeholder="search by name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="btn" onClick={() => entities.refetch()}>refresh</button>
        {selectedId && (
          <button className="btn" onClick={() => setSelectedId(null)}>clear selection</button>
        )}
      </div>

      {entities.data && entities.data.count === 0 && (
        <div className="empty">
          no entities yet — run <code>recall graph backfill</code> to seed from existing memories
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: selectedId ? "1fr 280px" : "1fr", gap: 16 }}>
        <div className="graph-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodeClick={handleNodeClick}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} />
            <Controls />
            <MiniMap pannable nodeColor={(n) => (n.style?.background as string) ?? "#444"} />
          </ReactFlow>
        </div>
        {selectedId && (
          <EntityPanel
            data={neighbors.data}
            onJump={(id) => setSelectedId(id)}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}

function buildEntityLayout(
  entities: EntityRow[],
  neighborRelations: EntityRelationRow[],
  selectedId: string | null,
): { nodes: Node[]; edges: Edge[] } {
  // Group by kind, then lay out in vertical columns.
  const byKind = new Map<EntityKind, EntityRow[]>();
  for (const e of entities) {
    const list = byKind.get(e.kind) ?? [];
    list.push(e);
    byKind.set(e.kind, list);
  }

  const nodes: Node[] = [];
  let col = 0;
  const xStep = 280;
  const yStep = 56;
  const nodeIds = new Set<string>();
  for (const [kind, list] of byKind) {
    const x = col * xStep;
    // column header (decorative node, no interaction)
    nodes.push({
      id: `header:${kind}`,
      data: { label: `${kind} (${list.length})` },
      position: { x, y: -50 },
      draggable: false,
      selectable: false,
      style: {
        background: "transparent",
        border: "none",
        color: KIND_COLORS[kind],
        fontSize: 11,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.5px",
        padding: 0,
      },
    });
    list
      .sort((a, b) => b.mention_count - a.mention_count)
      .slice(0, 18)
      .forEach((e, i) => {
        const isSelected = e.id === selectedId;
        nodes.push({
          id: e.id,
          data: { label: `${e.name}\n×${e.mention_count}` },
          position: { x, y: i * yStep },
          style: {
            background: isSelected ? KIND_COLORS[e.kind] : "#1c1f26",
            color: isSelected ? "#0b0c0f" : "#e6e6e6",
            border: `1.5px solid ${KIND_COLORS[e.kind]}`,
            borderRadius: 6,
            fontSize: 11,
            padding: "6px 9px",
            width: 240,
            whiteSpace: "pre-wrap",
          },
        });
        nodeIds.add(e.id);
      });
    col++;
  }

  const edges: Edge[] = neighborRelations
    .filter((r) => nodeIds.has(r.source_entity_id) && nodeIds.has(r.target_entity_id))
    .map((r) => ({
      id: r.id,
      source: r.source_entity_id,
      target: r.target_entity_id,
      animated: r.relation_type === "conflicts_with" || r.relation_type === "replaces",
      style: { stroke: RELATION_COLORS[r.relation_type] ?? "#555", strokeWidth: 1.5 },
      label: r.relation_type,
      labelStyle: { fill: RELATION_COLORS[r.relation_type] ?? "#888", fontSize: 9 },
      labelBgStyle: { fill: "#0b0c0f", fillOpacity: 0.7 },
    }));

  return { nodes, edges };
}

function EntityPanel({
  data,
  onJump,
  onClose,
}: {
  data: ReturnType<typeof api.graphNeighbors> extends Promise<infer R> ? R | undefined : never;
  onJump: (id: string) => void;
  onClose: () => void;
}) {
  if (!data) {
    return (
      <div className="card">
        <div className="empty">loading…</div>
      </div>
    );
  }
  const root = data.root;
  const otherEntities = data.entities.filter((e) => e.id !== root.id);
  const memories = data.memories_by_entity[root.id] ?? [];
  return (
    <div className="card" style={{ position: "sticky", top: 0, alignSelf: "start" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <span className="badge" style={{ color: KIND_COLORS[root.kind] }}>{root.kind}</span>
        <button className="btn" onClick={onClose} style={{ padding: "2px 8px" }}>✕</button>
      </div>
      <div className="memory-text" style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
        {root.name}
      </div>
      <div className="memory-meta" style={{ marginBottom: 10 }}>
        {root.repo ?? "global"} · {root.mention_count} mention{root.mention_count === 1 ? "" : "s"}
      </div>
      <div className="page-subtitle" style={{ marginBottom: 6 }}>
        Linked memories ({memories.length})
      </div>
      {memories.length === 0 && <div className="empty" style={{ padding: 8 }}>none</div>}
      {memories.slice(0, 8).map((mid) => (
        <div key={mid} className="memory-meta" style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
          {mid.slice(0, 8)}
        </div>
      ))}
      <div className="page-subtitle" style={{ marginTop: 14, marginBottom: 6 }}>
        Neighbours ({otherEntities.length})
      </div>
      {otherEntities.slice(0, 12).map((e) => (
        <button
          key={e.id}
          className="btn"
          onClick={() => onJump(e.id)}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            marginBottom: 4,
            borderColor: KIND_COLORS[e.kind],
            color: KIND_COLORS[e.kind],
          }}
        >
          {e.kind} · {e.name}
        </button>
      ))}
    </div>
  );
}
