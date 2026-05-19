import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api, type ActivityEvent, type SessionRow } from "../lib/api";
import { useLoadMore } from "../lib/useLoadMore";
import { LoadMore } from "../lib/LoadMore";

const PAGE_SIZE = 50;

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

export function SessionsPage() {
  const [params, setParams] = useSearchParams();
  const repo = params.get("repo") ?? "";
  const setRepo = (next: string) => {
    const p = new URLSearchParams(params);
    if (next) p.set("repo", next);
    else p.delete("repo");
    setParams(p, { replace: true });
  };

  const resetKey = useMemo(() => JSON.stringify({ repo }), [repo]);
  const page = useLoadMore<SessionRow, { repo: string }>({
    fetchPage: async (offset, q) => {
      const res = await api.sessions({
        repo: q.repo || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      return { items: res.sessions, has_more: res.has_more };
    },
    pageSize: PAGE_SIZE,
    resetKey,
    query: { repo },
    refetchInterval: 12_000,
  });

  const repos = useMemo(() => {
    const set = new Set<string>();
    for (const s of page.items) if (s.repo) set.add(s.repo);
    return [...set].sort();
  }, [page.items]);

  const list = page.items;

  return (
    <div>
      <header className="page-header">
        <div>
          <h1 className="page-title">Sessions</h1>
          <p className="page-subtitle">
            {list.length} session{list.length === 1 ? "" : "s"} — click one to inspect its events
          </p>
        </div>
      </header>

      <div className="toolbar">
        <select className="select" value={repo} onChange={(e) => setRepo(e.target.value)}>
          <option value="">all repos</option>
          {repos.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <button className="btn" onClick={() => page.refresh()} style={{ marginLeft: "auto" }}>
          refresh
        </button>
      </div>

      {page.isLoading && list.length === 0 && <div className="empty">loading…</div>}
      {!page.isLoading && list.length === 0 && <div className="empty">no sessions yet</div>}
      {list.map((s) => (
        <SessionCard key={s.session_id} session={s} />
      ))}
      <LoadMore
        hasMore={page.hasMore}
        isLoading={page.isLoadingMore}
        onLoadMore={page.loadMore}
        total={list.length}
      />
    </div>
  );
}

function SessionCard({ session }: { session: SessionRow }) {
  const [open, setOpen] = useState(false);
  const duration = durationLabel(session.first_at, session.last_at);

  return (
    <div
      className="card"
      style={{ marginBottom: 8, padding: "12px 14px", cursor: "pointer" }}
      onClick={() => setOpen(!open)}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 12, fontWeight: 600 }}>
          {session.session_id.slice(0, 8)}
          <span style={{ color: "var(--muted)" }}>…{session.session_id.slice(-4)}</span>
        </span>
        {session.repo && (
          <span style={{ color: "var(--muted)", fontSize: 12 }}>{session.repo}</span>
        )}
        <span className="badge" style={{ background: "var(--surface-2)", padding: "1px 6px" }}>
          {session.event_count} event{session.event_count === 1 ? "" : "s"}
        </span>
        <span style={{ color: "var(--muted)", fontSize: 11, fontFamily: "var(--mono)" }}>
          {duration}
        </span>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {session.event_types.map((t) => (
            <span
              key={t}
              style={{
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 3,
                color: TYPE_COLORS[t] ?? "var(--muted)",
                border: `1px solid ${TYPE_COLORS[t] ?? "var(--border)"}`,
              }}
            >
              {t}
            </span>
          ))}
        </div>
        <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 11 }}>
          {relative(session.last_at)} {open ? "▾" : "▸"}
        </span>
      </div>
      {open && <SessionDrilldown sessionId={session.session_id} />}
    </div>
  );
}

function SessionDrilldown({ sessionId }: { sessionId: string }) {
  const events = useQuery({
    queryKey: ["session-events", sessionId],
    queryFn: () => api.activity({ session_id: sessionId, limit: 500 }),
  });
  const list = (events.data?.events ?? []).slice().reverse();

  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 10 }} onClick={(e) => e.stopPropagation()}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span className="page-subtitle">{list.length} events (oldest first)</span>
        <Link
          to={`/timeline?session_id=${sessionId}`}
          className="btn"
          style={{ padding: "2px 8px", fontSize: 11 }}
        >
          open in timeline →
        </Link>
      </div>
      {events.isLoading && <div className="empty" style={{ padding: 8 }}>loading…</div>}
      {!events.isLoading && list.length === 0 && (
        <div className="empty" style={{ padding: 8 }}>no events</div>
      )}
      {list.map((e) => (
        <CompactEventRow key={e.id} event={e} />
      ))}
    </div>
  );
}

function CompactEventRow({ event }: { event: ActivityEvent }) {
  const color = TYPE_COLORS[event.event_type] ?? "var(--accent)";
  const summary = describeEvent(event);
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "baseline",
        padding: "4px 0",
        fontSize: 12,
        borderBottom: "1px dashed var(--border)",
      }}
    >
      <span style={{ color: "var(--muted)", fontFamily: "var(--mono)", fontSize: 10, minWidth: 60 }}>
        {shortTime(event.created_at)}
      </span>
      <span style={{ color, fontFamily: "var(--mono)", fontSize: 11, minWidth: 95 }}>
        {event.event_type}
      </span>
      <span style={{ color: "var(--muted)", fontSize: 11 }}>{event.source}</span>
      <span style={{ flex: 1, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
        {summary}
      </span>
    </div>
  );
}

function describeEvent(e: ActivityEvent): string {
  const req = e.request ?? {};
  const res = e.result ?? {};
  if (typeof req.name === "string") {
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
  return "";
}

function shortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

function durationLabel(firstIso: string, lastIso: string): string {
  try {
    const a = new Date(firstIso).getTime();
    const b = new Date(lastIso).getTime();
    const seconds = Math.max(0, Math.round((b - a) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${Math.round(seconds / 3600)}h`;
  } catch {
    return "—";
  }
}

function relative(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const s = Math.round(diff / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  } catch {
    return iso;
  }
}
