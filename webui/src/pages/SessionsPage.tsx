import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export function SessionsPage() {
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.sessions(undefined, 100),
  });

  return (
    <div>
      <header className="page-header">
        <div>
          <h1 className="page-title">Sessions</h1>
          <p className="page-subtitle">Distinct sessions Recall has seen across all agents</p>
        </div>
      </header>
      {sessions.isLoading && <div className="empty">loading…</div>}
      {sessions.data?.sessions.length === 0 && (
        <div className="empty">no sessions yet</div>
      )}
      {sessions.data?.sessions.map((s) => (
        <div className="card" key={s.session_id}>
          <div className="memory-text">{s.session_id}</div>
          <div className="memory-meta">
            {s.repo ?? "-"} · last={s.last_at} · events={s.event_count} ·
            types={s.event_types.join(",")}
          </div>
        </div>
      ))}
    </div>
  );
}
