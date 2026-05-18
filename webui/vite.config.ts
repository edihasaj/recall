import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Output to the daemon's dist/webui so the WebUI server can serve it directly.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "..", "dist", "webui"),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 7892, // dev server; the real bundle is served from :7891
    proxy: {
      // During `vite dev`, proxy API + WS calls to the running daemon so we
      // can iterate on the UI without rebuilding.
      "/api": {
        target: "http://localhost:7890",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
      "/ws": {
        target: "ws://localhost:7891",
        ws: true,
      },
    },
  },
});
