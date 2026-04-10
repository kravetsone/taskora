import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "/board/",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "../packages/taskora/src/board/static",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/board/api": "http://localhost:3000",
    },
  },
});
