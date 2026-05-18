import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export function ContradictionsPage() {
  const qc = useQueryClient();
  const contradictions = useQuery({
    queryKey: ["contradictions"],
    queryFn: () => api.contradictions(),
  });
  const resolve = useMutation({
    mutationFn: ({ id, keep }: { id: string; keep: string }) =>
      api.resolveContradiction(id, keep),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contradictions"] }),
  });

  const open = contradictions.data?.contradictions.filter((c) => !c.resolved) ?? [];

  return (
    <div>
      <header className="page-header">
        <div>
          <h1 className="page-title">Contradictions</h1>
          <p className="page-subtitle">Memory pairs that disagree — keep one to resolve</p>
        </div>
      </header>

      {contradictions.isLoading && <div className="empty">loading…</div>}
      {open.length === 0 && contradictions.data && (
        <div className="empty">no open contradictions — clean shop 🍃</div>
      )}
      {open.map((c) => (
        <div className="card" key={c.id}>
          <div className="memory-meta" style={{ marginBottom: 6 }}>
            <span className={`badge ${c.severity === "high" ? "rejected" : "candidate"}`}>
              {c.severity}
            </span>{" "}
            {c.contradiction_type}
          </div>
          <div className="memory-text" style={{ marginBottom: 10 }}>{c.description}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn"
              onClick={() => resolve.mutate({ id: c.id, keep: c.memory_a_id })}
            >
              keep A ({c.memory_a_id.slice(0, 8)})
            </button>
            <button
              className="btn"
              onClick={() => resolve.mutate({ id: c.id, keep: c.memory_b_id })}
            >
              keep B ({c.memory_b_id.slice(0, 8)})
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
