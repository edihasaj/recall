import { useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api, type ActivityEvent } from "../lib/api";
import { useLiveEvents } from "../lib/events";

const EVENT_TYPES = [
  "compile",
  "query",
  "scan",
  "correction",
  "review",
  "feedback",
  "signal",
  "session_start",
  "session_event",
  "session_end",
  "tool_call",
];

const TYPE_COLORS: Record<string, string> = {
  compile: "#7aa2f7",
  query: "#9ece6a",
  scan: "#bb9af7",
  correction: "#f7768e",
  review: "#7dcfff",
  feedback: "#e0af68",
  signal: "#f0c674",
  session_start: "#9ece6a",
  session_event: "#7aa2f7",
  session_end: "#f7768e",
  tool_call: "#bb9af7",
};

export function TimelinePage() {
  const [params, setParams] = useSearchParams();
  const repo = params.get("repo") ?? "";
  const source = params.get("source") ?? "";
  const eventType = params.get("event_type") ?? "";
  const sessionId = params.get("session_id") ?? "";

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const activity = useQuery({
    queryKey: ["activity", { repo, source, eventType, sessionId }],
    queryFn: () =>
      api.activity({
        repo: repo || undefined,
        source: source || undefined,
        event_type: eventType || undefined,
        session_id: sessionId || undefined,
        limit: 200,
      }),
    refetchInterval: 8_000,
  });
  const live = useLiveEvents(20);

  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const e of activity.data?.events ?? []) set.add(e.source);
    return [...set].sort();
  }, [activity.data]);
  const repos = useMemo(() => {
    const set = new Set<string>();
    for (const e of activity.data?.events ?? []) if (e.repo) set.add(e.repo);
    return [...set].sort();
  }, [activity.data]);

  const filtered = activity.data?.events ?? [];
  const hasFilter = repo || source || eventType || sessionId;

  return (
    <div>
      <header className="page-header">
        <div>
          <h1 className="page-title">Timeline</h1>
          <p className="page-subtitle">
            {filtered.length} event{filtered.length === 1 ? "" : "s"} ·
            live stream attached
          </p>
        </div>
        <div className="live-indicator">
          <span className="live-dot" /> WebSocket
        </div>
      </header>

      <div className="toolbar">
        <select className="select" value={repo} onChange={(e) => setParam("repo", e.target.value)}>
          <option value="">all repos</option>
          {repos.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <select className="select" value={source} onChange={(e) => setParam("source", e.target.value)}>
          <option value="">all sources</option>
          {sources.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select className="select" value={eventType} onChange={(e) => setParam("event_type", e.target.value)}>
          <option value="">all types</option>
          {EVENT_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        {sessionId && (
          <span className="badge" style={{ background: "var(--surface-2)", padding: "4px 8px" }}>
            session={sessionId.slice(0, 8)}
            <button
              className="btn"
              style={{ marginLeft: 6, padding: "0 6px" }}
              onClick={() => setParam("session_id", "")}
            >
              ✕
            </button>
          </span>
        )}
        {hasFilter && (
          <button
            className="btn"
            onClick={() => {
              setParams({}, { replace: true });
            }}
          >
            clear all
          </button>
        )}
        <button className="btn" onClick={() => activity.refetch()} style={{ marginLeft: "auto" }}>
          refresh
        </button>
      </div>

      {live.length > 0 && !hasFilter && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="page-subtitle" style={{ marginBottom: 8 }}>Live stream (last {live.length})</div>
          {live.slice().reverse().map((e, i) => (
            <div key={`${e.ts}-${i}`} className="timeline-event">
              <span className="timeline-time">{shortTime(e.ts)}</span>
              <span
                className="timeline-name"
                style={{ color: TYPE_COLORS[e.name] ?? "var(--accent)" }}
              >
                {e.name}
              </span>
              <span style={{ color: "var(--muted)" }}>{summarize(e.payload)}</span>
            </div>
          ))}
        </div>
      )}

      {activity.isLoading && <div className="empty">loading…</div>}
      {!activity.isLoading && filtered.length === 0 && (
        <div className="empty">no events match your filters</div>
      )}
      {filtered.map((e) => (
        <EventRow key={e.id} event={e} onJumpSession={(sid) => setParam("session_id", sid)} />
      ))}
    </div>
  );
}

function EventRow({
  event,
  onJumpSession,
}: {
  event: ActivityEvent;
  onJumpSession: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const color = TYPE_COLORS[event.event_type] ?? "var(--accent)";
  const summary = describeEvent(event);

  return (
    <div
      className="card"
      style={{ marginBottom: 6, padding: "10px 12px", cursor: "pointer" }}
      onClick={() => setOpen(!open)}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
        <span className="timeline-time" style={{ minWidth: 90 }}>
          {shortDateTime(event.created_at)}
        </span>
        <span
          className="badge"
          style={{ color, borderColor: color, border: "1px solid", padding: "1px 6px" }}
        >
          {event.event_type}
        </span>
        <span style={{ color: "var(--muted)", fontFamily: "var(--mono)", fontSize: 11 }}>
          {event.source}
        </span>
        {event.repo && (
          <span style={{ color: "var(--muted)", fontSize: 12 }}>{event.repo}</span>
        )}
        {event.memory_ids && event.memory_ids.length > 0 && (
          <span className="badge" style={{ background: "var(--surface-2)", padding: "1px 6px" }}>
            {event.memory_ids.length} mem
          </span>
        )}
        <span style={{ flex: 1, color: "var(--text-2)", fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {summary}
        </span>
        <span style={{ color: "var(--muted)", fontSize: 11 }}>{open ? "▾" : "▸"}</span>
      </div>

      {open && (
        <div style={{ marginTop: 10, fontSize: 12, fontFamily: "var(--mono)" }} onClick={(e) => e.stopPropagation()}>
          {event.session_id && (
            <div style={{ marginBottom: 8 }}>
              <span style={{ color: "var(--muted)" }}>session: </span>
              <button
                className="btn"
                style={{ padding: "0 6px", fontSize: 11 }}
                onClick={() => onJumpSession(event.session_id!)}
              >
                {event.session_id}
              </button>
            </div>
          )}
          {event.path && (
            <div style={{ marginBottom: 8 }}>
              <span style={{ color: "var(--muted)" }}>path: </span>
              <span>{event.path}</span>
            </div>
          )}
          {event.memory_ids && event.memory_ids.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <span style={{ color: "var(--muted)" }}>memories: </span>
              {event.memory_ids.map((mid) => (
                <Link
                  key={mid}
                  to={`/memories?focus=${mid}`}
                  style={{ color: "var(--accent)", marginRight: 8 }}
                >
                  {mid.slice(0, 8)}
                </Link>
              ))}
            </div>
          )}
          {hasContent(event.request) && (
            <details open style={{ marginBottom: 6 }}>
              <summary style={{ cursor: "pointer", color: "var(--muted)" }}>request</summary>
              <pre style={preStyle}>{JSON.stringify(event.request, null, 2)}</pre>
            </details>
          )}
          {hasContent(event.result) && (
            <details open style={{ marginBottom: 6 }}>
              <summary style={{ cursor: "pointer", color: "var(--muted)" }}>result</summary>
              <pre style={preStyle}>{JSON.stringify(event.result, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

const preStyle: CSSProperties = {
  background: "var(--surface-2)",
  padding: "8px 10px",
  borderRadius: 4,
  marginTop: 4,
  fontSize: 11,
  lineHeight: 1.45,
  maxHeight: 320,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  border: "1px solid var(--border)",
};

function hasContent(o: Record<string, unknown> | null | undefined): boolean {
  return !!o && Object.keys(o).length > 0;
}

function describeEvent(e: ActivityEvent): string {
  const req = e.request ?? {};
  const res = e.result ?? {};
  // Common shapes the daemon emits — extract the most useful one-liner.
  if (typeof req.name === "string") {
    // hook payloads: { client, name, repo_path } + result.tool_call or result.text
    const tc = (res as { tool_call?: { name?: string; input_summary?: string } }).tool_call;
    if (tc?.name) {
      return `${req.name} → ${tc.name}${tc.input_summary ? ` · ${tc.input_summary.slice(0, 80)}` : ""}`;
    }
    if (typeof (res as { text?: string }).text === "string") {
      return `${req.name} · ${(res as { text: string }).text.slice(0, 80)}`;
    }
    return String(req.name);
  }
  if (typeof req.query === "string") return `query: ${req.query.slice(0, 80)}`;
  if (typeof req.text === "string") return req.text.slice(0, 80);
  const reqKeys = Object.keys(req);
  if (reqKeys.length > 0) {
    return reqKeys.slice(0, 3).map((k) => `${k}=${stringifyShort((req as Record<string, unknown>)[k])}`).join(" · ");
  }
  return "";
}

function stringifyShort(v: unknown): string {
  if (v == null) return "-";
  if (typeof v === "string") return v.slice(0, 30);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return Array.isArray(v) ? `[${v.length}]` : "{…}";
}

function shortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function shortDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
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
