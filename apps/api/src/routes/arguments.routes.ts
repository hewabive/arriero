import { ArgumentDefaultsSchema } from "@llama-manager/core";
import type { Hono } from "hono";

import {
  getLlamaArgumentCatalog,
  getLlamaArgumentReferenceCatalog,
} from "../arguments/catalog.js";
import {
  getArgumentDefaults,
  saveArgumentDefaults,
} from "../arguments/defaults-repository.js";
import { generatedHelpChangedLines } from "../arguments/docs-source.js";
import { getLlamaArgumentDocsSyncReport } from "../arguments/docs-sync.js";
import { readArgumentEngineeringDoc } from "../arguments/docs.js";

export function registerArgumentRoutes(app: Hono) {
  app.get("/api/llama-args", (c) => {
    try {
      return c.json({
        data: getLlamaArgumentCatalog(c.req.query("binaryPath"), {
          refresh: c.req.query("refresh") === "true",
        }),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/api/llama-args/reference", (c) => {
    try {
      return c.json({
        data: getLlamaArgumentReferenceCatalog(),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/api/llama-args/docs/:primaryName", (c) => {
    try {
      const catalog = getLlamaArgumentReferenceCatalog();
      const primaryName = decodeURIComponent(c.req.param("primaryName"));
      const option =
        catalog.options.find((item) => item.primaryName === primaryName) ??
        null;
      return c.json({
        data: readArgumentEngineeringDoc({
          primaryName,
          option,
        }),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/api/llama-args/docs-sync", (c) => {
    try {
      return c.json({
        data: getLlamaArgumentDocsSyncReport(),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/api/llama-args/docs-sync/diff", (c) => {
    try {
      return c.json({ data: { diff: generatedHelpChangedLines() } });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/api/llama-args/defaults", (c) => {
    return c.json({ data: getArgumentDefaults() });
  });

  app.put("/api/llama-args/defaults", async (c) => {
    const parsed = ArgumentDefaultsSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    return c.json({ data: saveArgumentDefaults(parsed.data) });
  });
}
