/**
 * WebSocket bridge to the daemon's event bus. Auto-reconnects with
 * backoff. Components subscribe via the React hook below.
 */
import { useEffect, useState } from "react";

export interface EventEnvelope {
  name: string;
  payload: Record<string, unknown>;
  ts: string;
}

type Listener = (e: EventEnvelope) => void;

let ws: WebSocket | null = null;
let listeners = new Set<Listener>();
let backoff = 500;
let connectTimer: number | null = null;

function wsUrl(): string {
  const loc = window.location;
  const scheme = loc.protocol === "https:" ? "wss" : "ws";
  // In dev (vite proxy) and prod (same-origin serve from :7891) the path is the same.
  return `${scheme}://${loc.host}/ws`;
}

function connect(): void {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    backoff = 500;
  };
  ws.onmessage = (msg) => {
    try {
      const env = JSON.parse(msg.data) as EventEnvelope;
      for (const l of listeners) l(env);
    } catch {
      // ignore malformed frames
    }
  };
  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => {
    ws?.close();
  };
}

function scheduleReconnect(): void {
  if (connectTimer !== null) return;
  connectTimer = window.setTimeout(() => {
    connectTimer = null;
    backoff = Math.min(backoff * 2, 10_000);
    connect();
  }, backoff);
}

export function subscribe(listener: Listener): () => void {
  if (!ws) connect();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook: collect the last `limit` events into a rolling buffer. */
export function useLiveEvents(limit = 50): EventEnvelope[] {
  const [buffer, setBuffer] = useState<EventEnvelope[]>([]);
  useEffect(() => {
    const off = subscribe((e) => {
      setBuffer((prev) => {
        const next = [...prev, e];
        return next.length > limit ? next.slice(next.length - limit) : next;
      });
    });
    return off;
  }, [limit]);
  return buffer;
}
