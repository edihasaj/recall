import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D, { type ForceGraphMethods } from "react-force-graph-3d";
import SpriteText from "three-spritetext";
import * as THREE from "three";
import type { EntityKind, EntityRelationRow, EntityRow } from "../lib/api";

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

/**
 * Pick a readable text color for a given background hex by computing
 * perceived luminance (Rec. 709). Light backgrounds get near-black text,
 * dark backgrounds get near-white text. Prevents the white-on-yellow
 * unreadability for `library` / `tool` / `concept` kinds.
 */
function readableTextColor(bgHex: string): string {
  const m = bgHex.replace("#", "");
  if (m.length !== 6) return "#ffffff";
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.55 ? "#0b0c0f" : "#ffffff";
}

interface Node3D {
  id: string;
  name: string;
  kind: EntityKind;
  mentionCount: number;
  selected: boolean;
}

interface Link3D {
  source: string;
  target: string;
  relation: string;
}

export function Graph3DView({
  entities,
  relations,
  selectedId,
  onSelect,
}: {
  entities: EntityRow[];
  relations: EntityRelationRow[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const fgRef = useRef<ForceGraphMethods<Node3D, Link3D> | undefined>(undefined);
  const [dragEnabled, setDragEnabled] = useState(false);

  // Hold ⌃ Ctrl (or ⌘ on macOS) to enable node dragging for that gesture.
  // Releases the modifier — drag goes back off. Prevents accidental layout
  // warps from clicking-and-dragging during camera orbit.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) setDragEnabled(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) setDragEnabled(false);
    };
    const onBlur = () => setDragEnabled(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const data = useMemo(() => {
    const ids = new Set(entities.map((e) => e.id));
    const nodes: Node3D[] = entities.map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      mentionCount: e.mention_count,
      selected: e.id === selectedId,
    }));
    const links: Link3D[] = relations
      .filter((r) => ids.has(r.source_entity_id) && ids.has(r.target_entity_id))
      .map((r) => ({
        source: r.source_entity_id,
        target: r.target_entity_id,
        relation: r.relation_type,
      }));
    return { nodes, links };
  }, [entities, relations, selectedId]);

  // Orbit controls: left-drag rotates, middle-drag pans, right-drag also pans,
  // scroll wheel zooms.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const controls = fg.controls() as unknown as {
      mouseButtons?: { LEFT?: number; MIDDLE?: number; RIGHT?: number };
      enablePan?: boolean;
    } | null;
    if (!controls) return;
    controls.enablePan = true;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };
  }, []);

  useEffect(() => {
    if (!selectedId || !fgRef.current) return;
    const node = data.nodes.find((n) => n.id === selectedId) as
      | (Node3D & { x?: number; y?: number; z?: number })
      | undefined;
    if (!node || node.x == null) return;
    // Camera fly-to centred on the selected node.
    const distance = 140;
    const distRatio = 1 + distance / Math.hypot(node.x ?? 1, node.y ?? 1, node.z ?? 1);
    fgRef.current.cameraPosition(
      {
        x: (node.x ?? 0) * distRatio,
        y: (node.y ?? 0) * distRatio,
        z: (node.z ?? 0) * distRatio,
      },
      node,
      900,
    );
  }, [selectedId, data]);

  return (
    <div
      style={{
        position: "relative",
        height: "calc(100vh - 240px)",
        minHeight: 480,
        background: "#0b0c0f",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <ForceGraph3D
        ref={fgRef}
        graphData={data}
        controlType="orbit"
        backgroundColor="#0b0c0f"
        nodeId="id"
        nodeLabel={(n) => `${n.kind} · ${n.name} (×${n.mentionCount})`}
        nodeColor={(n) => KIND_COLORS[n.kind] ?? "#888"}
        nodeOpacity={0.92}
        nodeVal={(n) => Math.max(1, Math.log2(n.mentionCount + 1) * 3)}
        nodeThreeObject={(n) => {
          const sprite = new SpriteText(n.name);
          const kindColor = KIND_COLORS[n.kind] ?? "#555";
          if (n.selected) {
            sprite.backgroundColor = kindColor;
            sprite.color = readableTextColor(kindColor);
          } else {
            sprite.backgroundColor = "rgba(11, 12, 15, 0.88)";
            // Tinted text in the kind's color for unselected — keeps the
            // dark-background readability invariant ("white-ish on black").
            sprite.color = kindColor;
          }
          sprite.borderColor = kindColor;
          sprite.borderWidth = 0.6;
          sprite.borderRadius = 3;
          sprite.padding = 3;
          sprite.textHeight = n.selected ? 6 : 4;
          return sprite;
        }}
        nodeThreeObjectExtend
        linkColor={(l) => RELATION_COLORS[l.relation] ?? "#444"}
        linkDirectionalArrowLength={3}
        linkDirectionalArrowRelPos={1}
        linkDirectionalParticles={(l) =>
          l.relation === "conflicts_with" || l.relation === "replaces" ? 2 : 0
        }
        linkDirectionalParticleSpeed={0.004}
        linkOpacity={0.55}
        linkWidth={(l) => (l.relation === "conflicts_with" || l.relation === "replaces" ? 1.5 : 0.6)}
        onNodeClick={(n) => onSelect(n.id)}
        onBackgroundClick={() => onSelect(null)}
        enableNodeDrag={dragEnabled}
        onNodeDragEnd={(node) => {
          // Release the physics pin so the layout re-settles rather than
          // sticking wherever we dropped the node.
          (node as { fx?: number | null; fy?: number | null; fz?: number | null }).fx = undefined;
          (node as { fx?: number | null; fy?: number | null; fz?: number | null }).fy = undefined;
          (node as { fx?: number | null; fy?: number | null; fz?: number | null }).fz = undefined;
        }}
        warmupTicks={40}
        cooldownTicks={80}
      />
      <div
        style={{
          position: "absolute",
          bottom: 12,
          right: 14,
          padding: "4px 8px",
          borderRadius: 4,
          background: "rgba(11, 12, 15, 0.7)",
          border: `1px solid ${dragEnabled ? "var(--accent)" : "var(--border)"}`,
          color: dragEnabled ? "var(--accent)" : "var(--muted)",
          fontSize: 10,
          fontFamily: "var(--mono)",
          pointerEvents: "none",
          letterSpacing: 0.3,
          transition: "border-color 0.1s, color 0.1s",
        }}
      >
        {dragEnabled ? "drag mode: on" : "hold ⌃ / ⌘ to drag nodes"}
      </div>
    </div>
  );
}
