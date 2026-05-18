import { useQuery } from "@tanstack/react-query";
import { api, type ActivityEvent } from "../lib/api";
import { useLiveEvents } from "../lib/events";

export function TimelinePage() {
  const activity = useQuery({
    queryKey: ["activity"],
    queryFn: () => api.activity(undefined, 100),
    refetchInterval: 8_000,
  });
  const live = useLiveEvents(20);

  return (
    <div>
      <header className="page-header">
        <div>
          <h1 className="page-title">Timeline</h1>
          <p className="page-subtitle">Recorded activity and live event bus stream</p>
        </div>
        <div className="live-indicator">
          <span className="live-dot" /> WebSocket
        </div>
      </header>

      {live.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="page-subtitle" style={{ marginBottom: 8 }}>Live stream (last {live.length})</div>
          {live.slice().reverse().map((e, i) => (
            <div key={`${e.ts}-${i}`} className="timeline-event">
              <span className="timeline-time">{shortTime(e.ts)}</span>
              <span className="timeline-name">{e.name}</span>
              <span style={{ color: "var(--muted)" }}>{summarize(e.payload)}</span>
            </div>
          ))}
        </div>
      )}

      {activity.isLoading && <div className="empty">loading…</div>}
      {activity.data?.events.map((e) => (
        <ActivityRow key={e.id} event={e} />
      ))}
    </div>
  );
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  return (
    <div className="timeline-event">
      <span className="timeline-time">{shortTime(event.created_at)}</span>
      <span className="timeline-name">{event.event_type}</span>
      <span style={{ color: "var(--muted)" }}>
        {event.repo ?? "-"} · session={event.session_id?.slice(0, 8) ?? "-"} · mems=
        {event.memory_ids?.length ?? 0}
      </span>
    </div>
  );
}

function shortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function summarize(p: Record<string, unknown>): string {
  return Object.entries(p)
    .slice(0, 4)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 20) : String(v)}`)
    .join(" · ");
}
