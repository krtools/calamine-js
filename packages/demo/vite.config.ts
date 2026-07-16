import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// COOP/COEP is NOT required by calamine-wasm (that's a feature — see the
// library's DESIGN.md). It is sent here only because the browser's
// measureUserAgentSpecificMemory() API refuses to run without cross-origin
// isolation; the demo degrades gracefully when the headers are absent
// (e.g. on GitHub Pages, which cannot set them).
const memoryApiHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { headers: memoryApiHeaders },
  preview: { headers: memoryApiHeaders },
  build: {
    target: "es2022",
    // both engines are heavyweight; keep them out of the entry chunk
    chunkSizeWarningLimit: 1500,
    // calamine-wasm's client keeps Node-only dynamic imports behind isNode
    // guards (worker_threads, fs); they never execute in a browser, but
    // production Rollup still tries to resolve them.
    rollupOptions: { external: [/^node:/] },
  },
  worker: {
    format: "es" as const,
    rollupOptions: { external: [/^node:/] },
  },
});
