import { describe, it, expect, beforeEach } from "vitest";
import { emit, on, onAny, listenerCount, reset } from "../src/daemon/events.js";

describe("daemon event bus", () => {
  beforeEach(() => reset());

  it("delivers to named subscribers only", () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    on("memory.created", (e) => a.push(e));
    on("feedback.recorded", (e) => b.push(e));
    emit("memory.created", { memory_id: "m1", repo: "r", source: "test" });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
    expect((a[0] as { name: string }).name).toBe("memory.created");
  });

  it("delivers to onAny subscribers", () => {
    const seen: string[] = [];
    onAny((e) => seen.push(e.name));
    emit("memory.created", { memory_id: "m1", repo: null, source: "x" });
    emit("cleanup.tick", { run_id: "r", merges: 0, promotions: 0, suppressions: 0 });
    expect(seen).toEqual(["memory.created", "cleanup.tick"]);
  });

  it("unsubscribe stops delivery", () => {
    const seen: unknown[] = [];
    const off = on("memory.created", (e) => seen.push(e));
    off();
    emit("memory.created", { memory_id: "m1", repo: null, source: "x" });
    expect(seen).toHaveLength(0);
  });

  it("throwing handler does not break siblings", () => {
    const seen: number[] = [];
    on("memory.created", () => {
      throw new Error("boom");
    });
    on("memory.created", () => seen.push(1));
    expect(() =>
      emit("memory.created", { memory_id: "m1", repo: null, source: "x" }),
    ).not.toThrow();
    expect(seen).toEqual([1]);
  });

  it("listenerCount reports totals", () => {
    on("memory.created", () => {});
    on("memory.created", () => {});
    onAny(() => {});
    expect(listenerCount("memory.created")).toBe(2);
    expect(listenerCount()).toBe(3);
  });

  it("envelope carries ISO timestamp", () => {
    let envelope: { ts: string } | undefined;
    on("memory.created", (e) => (envelope = e));
    emit("memory.created", { memory_id: "m1", repo: null, source: "x" });
    expect(envelope?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
