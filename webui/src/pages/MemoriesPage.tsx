import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type MemoryItem } from "../lib/api";

export function MemoriesPage() {
  const qc = useQueryClient();
  const [repo, setRepo] = useState("");
  const [status, setStatus] = useState<string>("");

  const memories = useQuery({
    queryKey: ["memories", repo, status],
    queryFn: () => api.memories(repo || undefined, status || undefined, 200),
  });

  const confirm = useMutation({
    mutationFn: (id: string) => api.confirm(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memories"] }),
  });
  const reject = useMutation({
    mutationFn: (id: string) => api.reject(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memories"] }),
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
          onChange={(e) => setRepo(e.target.value)}
        />
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">all statuses</option>
          <option value="active">active</option>
          <option value="candidate">candidate</option>
          <option value="rejected">rejected</option>
        </select>
        <button className="btn" onClick={() => memories.refetch()}>refresh</button>
      </div>

      {memories.isLoading && <div className="empty">loading…</div>}
      {memories.isError && (
        <div className="empty">
          could not reach daemon — check `recall daemon status`
        </div>
      )}
      {memories.data?.memories.length === 0 && (
        <div className="empty">no memories yet — capture some via your agent</div>
      )}
      {memories.data?.memories.map((m) => (
        <MemoryRow
          key={m.id}
          memory={m}
          onConfirm={() => confirm.mutate(m.id)}
          onReject={() => reject.mutate(m.id)}
        />
      ))}
    </div>
  );
}

function MemoryRow({
  memory,
  onConfirm,
  onReject,
}: {
  memory: MemoryItem;
  onConfirm: () => void;
  onReject: () => void;
}) {
  return (
    <div className="card memory-row">
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
