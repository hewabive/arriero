import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { requireAdmin } from "./auth.js";
import {
  registerAnthropicProxyRoutes,
  registerOpenAiProxyRoutes,
} from "./proxy/protocol-routes.js";
import { registerArgumentRoutes } from "./routes/arguments.routes.js";
import { registerAuthRoutes } from "./routes/auth.routes.js";
import { registerBuildRoutes } from "./routes/build.routes.js";
import { registerConfigGitRoutes } from "./routes/config-git.routes.js";
import { registerEnvironmentRoutes } from "./routes/environments.routes.js";
import { registerEndpointRoutes } from "./routes/endpoints.routes.js";
import { registerInstanceActionRoutes } from "./routes/instance-actions.routes.js";
import { registerInstanceLlamaRoutes } from "./routes/instance-llama.routes.js";
import { registerInstanceRoutes } from "./routes/instances.routes.js";
import { registerLabRoutes } from "./routes/lab.routes.js";
import { registerLlamaSourceRoutes } from "./routes/llama-source.routes.js";
import { registerMemoryEstimateRoutes } from "./routes/memory-estimate.routes.js";
import { registerModelRoutes } from "./routes/models.routes.js";
import { registerNodeRoutes } from "./routes/nodes.routes.js";
import { registerPathCatalogRoutes } from "./routes/path-catalog.routes.js";
import { registerPrerequisiteRoutes } from "./routes/prerequisites.routes.js";
import { registerPresetRoutes } from "./routes/presets.routes.js";
import { registerProxyRoutes } from "./routes/proxy.routes.js";
import { registerResourceRoutes } from "./routes/resources.routes.js";
import { registerSourceRepositoryRoutes } from "./routes/source-repositories.routes.js";
import { registerProxyTargetRoutes } from "./routes/proxy-targets.routes.js";
import { registerSystemRoutes } from "./routes/system.routes.js";
import { registerUpdateRoutes } from "./routes/update.routes.js";

export { startApiProxyIdleMaintenanceLoop } from "./proxy/idle-maintenance.js";
export { startApiProxyRuntimeReconcileLoop } from "./proxy/runtime-snapshot.js";

export const app = new Hono();

app.use(
  "*",
  cors({
    origin: ["http://127.0.0.1:5173", "http://localhost:5173"],
    credentials: true,
  }),
);

app.use("/api/*", requireAdmin);

registerSystemRoutes(app);
registerPrerequisiteRoutes(app);
registerAuthRoutes(app);

registerOpenAiProxyRoutes(app, "/proxy/v1");
registerOpenAiProxyRoutes(app, "/v1");
registerAnthropicProxyRoutes(app, "/proxy/anthropic/v1");
registerAnthropicProxyRoutes(app, "/v1");

registerPathCatalogRoutes(app);
registerNodeRoutes(app);
registerResourceRoutes(app);
registerMemoryEstimateRoutes(app);
registerProxyRoutes(app);
registerEndpointRoutes(app);
registerLabRoutes(app);
registerProxyTargetRoutes(app);
registerArgumentRoutes(app);
registerSourceRepositoryRoutes(app);
registerLlamaSourceRoutes(app);
registerBuildRoutes(app);
registerEnvironmentRoutes(app);
registerConfigGitRoutes(app);
registerUpdateRoutes(app);
registerModelRoutes(app);
registerPresetRoutes(app);
registerInstanceRoutes(app);
registerInstanceLlamaRoutes(app);
registerInstanceActionRoutes(app);

const webDistDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../web/dist",
);

if (existsSync(webDistDir)) {
  app.use("/*", serveStatic({ root: webDistDir }));

  const serveWebIndex = serveStatic({ root: webDistDir, path: "index.html" });
  app.notFound((c) => {
    const path = c.req.path;
    const isApiNamespace =
      path.startsWith("/api/") ||
      path.startsWith("/v1") ||
      path.startsWith("/proxy/");
    if (c.req.method === "GET" && !isApiNamespace) {
      return serveWebIndex(c, async () => undefined) as Promise<Response>;
    }
    return c.json({ error: "not found" }, 404);
  });
}
