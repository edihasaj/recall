import { defineConfig } from "tsup";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync(new URL("./package-lock.json", import.meta.url), "utf8"));
const dependencyNames = [
  "@huggingface/transformers",
  "onnxruntime-node",
  "better-sqlite3",
  "sqlite-vec",
  "@photostructure/sqlite-vec",
];
const dependencies = Object.fromEntries(
  dependencyNames.map((name) => [name, lock.packages[`node_modules/${name}`]?.version ?? "unknown"]),
);
let sha = process.env.GITHUB_SHA ?? null;
if (!sha) {
  try {
    sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    sha = null;
  }
}
const buildInfo = { sha, built_at: new Date().toISOString(), dependencies };

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    daemon: "src/daemon.ts",
    mcp: "src/mcp/server.ts",
    "sync-server": "src/sync/server.ts",
  },
  format: ["esm"],
  target: "node22",
  splitting: true,
  sourcemap: true,
  clean: true,
  define: {
    __RECALL_BUILD_INFO__: JSON.stringify(buildInfo),
  },
  external: ["sqlite-vec", "@photostructure/sqlite-vec"],
  // drizzle-orm's subpaths (e.g. `drizzle-orm/sqlite-core`) hit
  // ERR_UNSUPPORTED_DIR_IMPORT under pnpm + ESM on Windows when the
  // daemon child is spawned from a non-elevated user session. Bundling
  // it sidesteps runtime bare-specifier resolution entirely.
  noExternal: [/^drizzle-orm(\/|$)/],
});
