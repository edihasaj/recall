import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, type ContradictionRow } from "../lib/api";
import { useLoadMore } from "../lib/useLoadMore";
import { LoadMore } from "../lib/LoadMore";

const PAGE_SIZE = 50;

export function ContradictionsPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const resolvedFilter = params.get("resolved") ?? "open"; // open | resolved | all
  const setResolved = (next: string) => {
    const p = new URLSearchParams(params);
    if (next === "open") p.delete("resolved");
    else p.set("resolved", next);
    setParams(p, { replace: true });
  };

  const resolvedBool = resolvedFilter === "open" ? false : resolvedFilter === "resolved" ? true : undefined;
  const resetKey = useMemo(() => JSON.stringify({ resolvedFilter }), [resolvedFilter]);

  const page = useLoadMore<ContradictionRow, { resolved?: boolean }>({
    fetchPage: async (offset, q) => {
      const res = await api.contradictions({ resolved: q.resolved, limit: PAGE_SIZE, offset });
      return { items: res.contradictions, has_more: res.has_more };
    },
    pageSize: PAGE_SIZE,
    resetKey,
    query: { resolved: resolvedBool },
    refetchInterval: 20_000,
  });

  const resolve = useMutation({
    mutationFn: ({ id, keep }: { id: string; keep: string }) =>
      api.resolveContradiction(id, keep),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contradictions"] });
      page.refresh();
    },
  });

  return (
    <div>
      <header className="page-header">
        <div>
          <h1 className="page-title">Contradictions</h1>
          <p className="page-subtitle">Memory pairs that disagree — keep one to resolve</p>
        </div>
      </header>

      <div className="toolbar">
        <select
          className="select"
          value={resolvedFilter}
          onChange={(e) => setResolved(e.target.value)}
        >
          <option value="open">open only</option>
          <option value="resolved">resolved only</option>
          <option value="all">all</option>
        </select>
        <button className="btn" onClick={() => page.refresh()} style={{ marginLeft: "auto" }}>
          refresh
        </button>
      </div>

      {page.isLoading && page.items.length === 0 && <div className="empty">loading…</div>}
      {!page.isLoading && page.items.length === 0 && (
        <div className="empty">
          {resolvedFilter === "open" ? "no open contradictions — clean shop 🍃" : "nothing to show"}
        </div>
      )}
      {page.items.map((c) => (
        <div className="card" key={c.id}>
          <div className="memory-meta" style={{ marginBottom: 6 }}>
            <span className={`badge ${c.severity === "high" ? "rejected" : "candidate"}`}>
              {c.severity}
            </span>{" "}
            {c.contradiction_type}
            {c.resolved && <span style={{ marginLeft: 8, color: "var(--muted)" }}>· resolved</span>}
          </div>
          <div className="memory-text" style={{ marginBottom: 10 }}>{c.description}</div>
          {!c.resolved && (
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
          )}
        </div>
      ))}
      <LoadMore
        hasMore={page.hasMore}
        isLoading={page.isLoadingMore}
        onLoadMore={page.loadMore}
        total={page.items.length}
      />
    </div>
  );
}
