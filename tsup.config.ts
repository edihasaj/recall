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
});
