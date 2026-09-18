import Database from "better-sqlite3";

export interface HookActivity {
  status: "recent" | "stale" | "never" | "unavailable";
  last_success_at: string | null;
  events: Record<string, string>;
}

export function readHookActivity(dbPath: string, agent: string, now = Date.now()): HookActivity {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(
      "SELECT event, MAX(created_at) AS latest FROM hook_calls WHERE agent=? AND ok=1 GROUP BY event",
    ).all(agent) as Array<{ event: string; latest: string }>;
    const events = Object.fromEntries(rows.map((r) => [r.event, r.latest]));
    const last = rows.map((r) => r.latest).sort().at(-1) ?? null;
    return {
      status: !last ? "never" : now - Date.parse(last) > 7 * 86_400_000 ? "stale" : "recent",
      last_success_at: last,
      events,
    };
  } catch {
    return { status: "unavailable", last_success_at: null, events: {} };
  } finally {
    db?.close();
  }
}

// Trust is keyed by the lexical hooks.json path, even when profiles symlink
// the same file. Presence is only a prerequisite; Codex /hooks checks hashes.
export function missingCodexTrustKeys(config: string, hooksPath: string, definition: unknown): string[] {
  const events = (definition as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> })?.hooks ?? {};
  const missing: string[] = [];
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue;
    const snake = event.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    groups.forEach((group, gi) => group.hooks?.forEach((hook, hi) => {
      if (!hook.command?.includes("recall:managed:codex:")) return;
      const key = `${hooksPath}:${snake}:${gi}:${hi}`;
      const header = `[hooks.state.${JSON.stringify(key)}]`;
      const start = config.indexOf(header);
      const section = start < 0 ? "" : config.slice(start + header.length).split(/\n\s*\[/, 1)[0];
      if (!/\btrusted_hash\s*=\s*"sha256:[a-f0-9]+"/.test(section)) missing.push(key);
    }));
  }
  return missing;
}
