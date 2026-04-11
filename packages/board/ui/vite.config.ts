import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  // Pin root to ui/ so `vite --config ui/vite.config.ts build` works from any
  // cwd (e.g. `packages/board`) — without this vite defaults to cwd and can't
  // find index.html.
  root: __dirname,
  plugins: [react()],
  base: "/board/",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "../static"),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/board/api": "http://localhost:3000",
    },
  },
});
