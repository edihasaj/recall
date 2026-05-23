import { defineConfig } from "tsup";

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
  external: ["sqlite-vec"],
  // drizzle-orm's subpaths (e.g. `drizzle-orm/sqlite-core`) hit
  // ERR_UNSUPPORTED_DIR_IMPORT under pnpm + ESM on Windows when the
  // daemon child is spawned from a non-elevated user session. Bundling
  // it sidesteps runtime bare-specifier resolution entirely.
  noExternal: [/^drizzle-orm(\/|$)/],
});
