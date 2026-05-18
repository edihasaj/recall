/**
 * Tiny in-process pub/sub used by the daemon to broadcast lifecycle events
 * to subscribers (currently the WebUI WebSocket bridge). Synchronous,
 * unbounded, best-effort. Subscribers must be cheap or schedule their own
 * async work — emit() never awaits.
 */

export interface EventMap {
  "memory.created": {
    memory_id: string;
    repo: string | null;
    source: string;
    type?: string;
  };
  "memory.updated": {
    memory_id: string;
    repo: string | null;
    change: "status" | "text" | "scope" | "confidence";
  };
  "memory.rejected": {
    memory_id: string;
    repo: string | null;
    actor?: string;
  };
  "memory.confirmed": {
    memory_id: string;
    repo: string | null;
  };
  "feedback.recorded": {
    memory_id: string;
    session_id: string;
    outcome: string;
    injected: boolean;
  };
  "contradiction.detected": {
    contradiction_id: string;
    memory_a: string;
    memory_b: string;
    severity: string;
  };
  "contradiction.resolved": {
    contradiction_id: string;
    keep_memory_id: string;
  };
  "dispatcher.tick": {
    provider: string;
    attempted: number;
    applied: number;
    rejected: number;
  };
  "cleanup.tick": {
    run_id: string;
    merges: number;
    promotions: number;
    suppressions: number;
  };
  "scan.completed": {
    repo: string | null;
    created: number;
    repo_path?: string;
  };
  "session.started": {
    session_id: string;
    client: string | null;
    repo: string | null;
  };
  "session.ended": {
    session_id: string;
    repo: string | null;
  };
}

export type EventName = keyof EventMap;
export type EventPayload<T extends EventName> = EventMap[T];
export type EventEnvelope<T extends EventName = EventName> = {
  name: T;
  payload: EventPayload<T>;
  ts: string;
};

type Handler<T extends EventName> = (envelope: EventEnvelope<T>) => void;
type AnyHandler = (envelope: EventEnvelope) => void;

const handlers = new Map<EventName, Set<Handler<EventName>>>();
const anyHandlers = new Set<AnyHandler>();

export function on<T extends EventName>(name: T, handler: Handler<T>): () => void {
  let set = handlers.get(name);
  if (!set) {
    set = new Set();
    handlers.set(name, set);
  }
  set.add(handler as Handler<EventName>);
  return () => {
    set?.delete(handler as Handler<EventName>);
  };
}

export function onAny(handler: AnyHandler): () => void {
  anyHandlers.add(handler);
  return () => {
    anyHandlers.delete(handler);
  };
}

export function emit<T extends EventName>(name: T, payload: EventPayload<T>): void {
  const envelope: EventEnvelope<T> = {
    name,
    payload,
    ts: new Date().toISOString(),
  };
  const set = handlers.get(name);
  if (set) {
    for (const h of set) {
      try {
        h(envelope as EventEnvelope<EventName>);
      } catch (err) {
        // A bad subscriber must not break the emitter. Log and move on.
        console.error(`[recall] event handler for ${name} threw:`, err);
      }
    }
  }
  for (const h of anyHandlers) {
    try {
      h(envelope as EventEnvelope);
    } catch (err) {
      console.error(`[recall] any-event handler threw:`, err);
    }
  }
}

export function listenerCount(name?: EventName): number {
  if (name) return handlers.get(name)?.size ?? 0;
  let n = anyHandlers.size;
  for (const s of handlers.values()) n += s.size;
  return n;
}

export function reset(): void {
  handlers.clear();
  anyHandlers.clear();
}
