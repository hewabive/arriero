import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type PluginOption } from "vite";

function buildCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function watchWorkspacePackages(): PluginOption {
  return {
    name: "watch-workspace-packages",
    configureServer(server) {
      server.watcher.add([
        fileURLToPath(new URL("../../packages/core/src", import.meta.url)),
        fileURLToPath(
          new URL(
            "../../packages/anthropic-openai-bridge/src",
            import.meta.url,
          ),
        ),
      ]);
    },
  };
}

export default defineConfig(({ command }) => ({
  base: command === "build" ? "./" : "/",
  define: {
    __ARRIERO_UI_COMMIT__: JSON.stringify(buildCommit()),
  },
  plugins: [react(), watchWorkspacePackages()],
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
