#!/usr/bin/env node
/**
 * Seed the screenshot/demo database with a curated, entirely fictional
 * dataset — imaginary company ("Northwind"), imaginary repos, imaginary
 * teammates. Nothing here references a real project, path, or person, so the
 * output is safe to publish on the marketing site.
 *
 * Usage:  node scripts/seed-demo-dataset.mjs [dataDir]
 * Default dataDir: ~/.recall-demo
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const dataDir = process.argv[2] ?? join(homedir(), ".recall-demo");
const dbPath = join(dataDir, "recall.db");

const REPOS = {
  store: "northwind/storefront",
  api: "northwind/payments-api",
  infra: "northwind/infra",
};

/** [type, text, repo|null (null = global), confidence] */
const MEMORIES = [
  ["rule", "Always use pnpm in this repo — never npm or yarn.", REPOS.store, 0.94],
  ["rule", "Prices are integers in minor units. Never store a float for money.", REPOS.store, 0.91],
  ["rule", "Never hardcode a tax rate — read it from `config/tax.ts`.", REPOS.store, 0.88],
  ["rule", "All user-facing copy goes through `t()`; no bare strings in JSX.", REPOS.store, 0.86],
  ["rule", "Use `@/` path aliases for imports, not deep relative paths.", REPOS.store, 0.83],
  ["gotcha", "`CartSummary` re-renders on every keystroke — memoise before adding fields.", REPOS.store, 0.79],
  ["command", "Run `pnpm test --filter storefront` before pushing.", REPOS.store, 0.9],
  ["decision", "We chose `zod` over `yup` for schema validation; don't reintroduce yup.", REPOS.store, 0.87],
  ["decision", "Checkout state lives in `zustand`, not React context.", REPOS.store, 0.84],

  ["rule", "Refunds must be idempotent — key every refund on `payment_intent`.", REPOS.api, 0.95],
  ["rule", "Never log a full card number or CVC, even at debug level.", REPOS.api, 0.96],
  ["rule", "Every endpoint returns a typed error envelope; no bare 500s.", REPOS.api, 0.85],
  ["rule", "Use `drizzle` migrations — no hand-edited SQL against production.", REPOS.api, 0.89],
  ["gotcha", "Webhook retries can arrive out of order; dedupe on `event_id`.", REPOS.api, 0.88],
  ["gotcha", "The sandbox gateway rounds differently than production — assert on cents.", REPOS.api, 0.76],
  ["command", "Regenerate API types with `pnpm codegen` after schema changes.", REPOS.api, 0.9],
  ["decision", "Payments run through one gateway adapter so we can swap providers.", REPOS.api, 0.82],

  ["rule", "Run `terraform plan` and read it before every apply.", REPOS.infra, 0.93],
  ["rule", "Never set `securityContext.privileged = true` in a chart.", REPOS.infra, 0.92],
  ["rule", "Secrets come from the vault at deploy time — never commit a `.env`.", REPOS.infra, 0.94],
  ["gotcha", "The staging cluster autoscales to zero overnight; warm it before demos.", REPOS.infra, 0.78],
  ["command", "Tail deploy logs with `nw logs --env staging --follow`.", REPOS.infra, 0.86],
  ["decision", "Blue/green deploys only — no in-place rolling updates for the API.", REPOS.infra, 0.84],

  // Entity-dense entries — these give the knowledge graph something to draw.
  ["decision", "`drizzle-orm` replaces `prisma` across the API; don't reintroduce prisma.", REPOS.api, 0.9],
  ["decision", "`vitest` replaces `jest` for unit tests — jest config is gone.", null, 0.89],
  ["rule", "`checkout` depends on `pricing-engine`; don't import it the other way.", REPOS.store, 0.85],
  ["rule", "The storefront uses `tanstack-query` for server state, not `redux`.", REPOS.store, 0.87],
  ["rule", "Use `playwright` for end-to-end tests; `cypress` is deprecated here.", REPOS.store, 0.86],
  ["decision", "`fastify` replaces `express` in the payments API for throughput.", REPOS.api, 0.88],
  ["rule", "`stripe-adapter` depends on `gateway-core` — keep the boundary clean.", REPOS.api, 0.83],
  ["gotcha", "`pino` logs are JSON in prod; `pino-pretty` is dev-only.", REPOS.api, 0.8],
  ["rule", "Validate every request body with `zod` before it reaches `drizzle-orm`.", REPOS.api, 0.9],
  ["rule", "`terraform` modules live in `modules/`; `helm` charts live in `charts/`.", REPOS.infra, 0.84],
  ["decision", "`opentelemetry` replaces `statsd` for metrics across all services.", REPOS.infra, 0.86],
  ["gotcha", "`grafana` dashboards depend on `prometheus` labels — rename carefully.", REPOS.infra, 0.79],
  ["rule", "Build images with `docker` buildx; `podman` is unsupported on CI.", REPOS.infra, 0.82],
  ["rule", "`tailwindcss` utilities only — no ad-hoc CSS modules in the storefront.", REPOS.store, 0.85],
  ["decision", "We use `turborepo` to orchestrate builds; it replaces the old make setup.", null, 0.83],
  ["rule", "Type everything with `typescript` strict mode; `any` needs a comment.", null, 0.9],
  ["rule", "Conventional commits are required; the release job parses them.", null, 0.9],
  ["rule", "Never force-push to `main`; open a PR even for one-line fixes.", null, 0.93],
  ["rule", "Add a regression test with every bug fix.", null, 0.88],
  ["rule", "Keep source files under ~500 lines; split when they grow past it.", null, 0.8],
  ["command", "Run the full gate — `pnpm lint && pnpm typecheck && pnpm test` — before handoff.", null, 0.91],
  ["decision", "We document architecture decisions in `docs/adr/`, one file per decision.", null, 0.81],
];

const TOOLS = [
  ["Bash", "pnpm test --filter storefront"],
  ["Edit", "src/checkout/CartSummary.tsx"],
  ["Read", "src/checkout/pricing.ts"],
  ["Bash", "pnpm lint && pnpm typecheck"],
  ["Grep", "usePricing( in src/"],
  ["Edit", "src/payments/refund.ts"],
  ["Bash", "terraform plan -out tfplan"],
  ["Read", "docs/adr/0007-gateway-adapter.md"],
  ["Edit", "charts/api/values.yaml"],
  ["Bash", "pnpm codegen"],
];
const PROMPTS = [
  "always use pnpm here, never npm",
  "refunds have to be idempotent — key on payment_intent",
  "add a regression test before fixing the rounding bug",
  "never hardcode the tax rate, read it from config",
  "read the terraform plan before applying",
];

const sql = [];
const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

sql.push("DELETE FROM memory_entities;", "DELETE FROM entity_relations;", "DELETE FROM entities;");
sql.push("DELETE FROM activity_events;", "DELETE FROM memories;");

MEMORIES.forEach(([type, text, repo, confidence], i) => {
  const created = iso(now - (MEMORIES.length - i) * 3_600_000);
  sql.push(
    `INSERT INTO memories (id,type,text,scope,path_scope,repo,status,confidence,source,evidence,capture_context,supersedes,created_at,updated_at,last_validated_at,last_injected_at,injection_count,override_count,repetition_count,team_id,sync_version,auto_inject,dedupe_key) VALUES (` +
      `${q(randomUUID())},${q(type)},${q(text)},${q(repo ? "repo" : "global")},NULL,${q(repo)},'active',${confidence},` +
      `'user_correction','[]','null',NULL,${q(created)},${q(created)},${q(created)},NULL,` +
      `${3 + (i % 9)},0,${1 + (i % 3)},NULL,0,1,${q(randomUUID())});`,
  );
});

// Agent activity: four sessions across the three repos.
const sessions = [
  { id: "sess-2a90cf", repo: REPOS.store, src: "hook:claude-code", client: "claude-code" },
  { id: "sess-7b1c08", repo: REPOS.api, src: "hook:codex", client: "codex" },
  { id: "sess-4d55e2", repo: REPOS.infra, src: "hook:claude-code", client: "claude-code" },
  { id: "sess-9f2a41", repo: REPOS.store, src: "mcp", client: "mcp" },
];
let t = now - 52 * 60_000;
const ev = (s, type, request, result, mems = []) => {
  t += (30 + Math.floor(Math.random() * 80)) * 1000;
  sql.push(
    `INSERT INTO activity_events (id,session_id,repo,path,source,event_type,memory_ids,request,result,created_at,dedupe_key) VALUES (` +
      `${q(randomUUID())},${q(s.id)},${q(s.repo)},NULL,${q(s.src)},${q(type)},${q(JSON.stringify(mems))},` +
      `${q(JSON.stringify(request))},${q(JSON.stringify(result))},${q(iso(t))},NULL);`,
  );
};
for (const s of sessions) {
  ev(s, "session_event", { name: "session_started", client: s.client, repo_path: `/work/${s.repo}` }, { injected: 6 });
  const n = 4 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const [tool, summary] = TOOLS[Math.floor(Math.random() * TOOLS.length)];
    ev(s, "session_event", { name: "tool_invoked", client: s.client }, { tool_call: { name: tool, input_summary: summary } });
    if (i % 3 === 1) {
      ev(s, "session_event", { name: "prompt_submitted", client: s.client }, { text: PROMPTS[Math.floor(Math.random() * PROMPTS.length)] });
    }
  }
  ev(s, "correction", { text: PROMPTS[Math.floor(Math.random() * PROMPTS.length)] }, { created: 1 }, [randomUUID()]);
  ev(s, "session_end", { name: "session_ended", client: s.client, repo_path: `/work/${s.repo}` }, { turn_count: n * 2 });
}

execFileSync("sqlite3", [dbPath], { input: sql.join("\n") + "\n", stdio: ["pipe", "inherit", "inherit"] });
console.log(`seeded ${MEMORIES.length} memories + activity into ${dbPath}`);
