import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, type MemoryItem } from "../lib/api";
import { useLoadMore } from "../lib/useLoadMore";
import { LoadMore } from "../lib/LoadMore";

const PAGE_SIZE = 50;

export function MemoriesPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const repo = params.get("repo") ?? "";
  const status = params.get("status") ?? "";
  const focusId = params.get("focus");

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const resetKey = useMemo(() => JSON.stringify({ repo, status }), [repo, status]);

  const page = useLoadMore<MemoryItem, { repo: string; status: string }>({
    fetchPage: async (offset, q) => {
      const res = await api.memories({
        repo: q.repo || undefined,
        status: q.status || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      return { items: res.memories, has_more: res.has_more };
    },
    pageSize: PAGE_SIZE,
    resetKey,
    query: { repo, status },
    refetchInterval: 12_000,
  });

  // Auto-scroll to a focused memory if provided via ?focus=<id> from a deep
  // link (e.g. timeline event row).
  useEffect(() => {
    if (!focusId) return;
    const el = document.getElementById(`memory-${focusId}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusId, page.items]);

  const confirm = useMutation({
    mutationFn: (id: string) => api.confirm(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["memories"] });
      page.refresh();
    },
  });
  const reject = useMutation({
    mutationFn: (id: string) => api.reject(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["memories"] });
      page.refresh();
    },
  });

  return (
    <div>
      <header className="page-header">
        <div>
          <h1 className="page-title">Memories</h1>
          <p className="page-subtitle">All rules, gotchas, decisions captured by Recall</p>
        </div>
        <div className="live-indicator">
          <span className="live-dot" /> live
        </div>
      </header>

      <div className="toolbar">
        <input
          className="input"
          placeholder="filter by repo (e.g. recall)"
          value={repo}
          onChange={(e) => setParam("repo", e.target.value)}
        />
        <select className="select" value={status} onChange={(e) => setParam("status", e.target.value)}>
          <option value="">all statuses</option>
          <option value="active">active</option>
          <option value="candidate">candidate</option>
          <option value="rejected">rejected</option>
        </select>
        <button className="btn" onClick={() => page.refresh()} style={{ marginLeft: "auto" }}>
          refresh
        </button>
      </div>

      {page.isLoading && page.items.length === 0 && <div className="empty">loading…</div>}
      {page.error != null && (
        <div className="empty">could not reach daemon — check `recall daemon status`</div>
      )}
      {!page.isLoading && page.items.length === 0 && (
        <div className="empty">no memories yet — capture some via your agent</div>
      )}
      {page.items.map((m) => (
        <MemoryRow
          key={m.id}
          memory={m}
          focused={m.id === focusId}
          onConfirm={() => confirm.mutate(m.id)}
          onReject={() => reject.mutate(m.id)}
        />
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

function MemoryRow({
  memory,
  focused,
  onConfirm,
  onReject,
}: {
  memory: MemoryItem;
  focused: boolean;
  onConfirm: () => void;
  onReject: () => void;
}) {
  return (
    <div
      id={`memory-${memory.id}`}
      className="card memory-row"
      style={focused ? { borderColor: "var(--accent)", boxShadow: "0 0 0 1px var(--accent)" } : undefined}
    >
      <span className={`badge ${memory.status}`}>{memory.status}</span>
      <div>
        <div className="memory-text">{memory.text}</div>
        <div className="memory-meta">
          {memory.type} · {memory.repo ?? "global"} · scope={memory.scope} · conf=
          {memory.confidence.toFixed(2)}
          {memory.source ? ` · src=${memory.source}` : ""}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        {memory.status === "candidate" && (
          <button className="btn primary" onClick={onConfirm}>confirm</button>
        )}
        {memory.status !== "rejected" && (
          <button className="btn danger" onClick={onReject}>reject</button>
        )}
      </div>
    </div>
  );
}
