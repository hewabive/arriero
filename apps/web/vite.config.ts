import { execFileSync } from "node:child_process";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function buildCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig(({ command }) => ({
  base: command === "build" ? "./" : "/",
  define: {
    __ARRIERO_UI_COMMIT__: JSON.stringify(buildCommit()),
  },
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
      "/proxy": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
      "/v1": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
}));
