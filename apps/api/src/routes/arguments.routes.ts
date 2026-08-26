import {
  ArgumentDefaultsSchema,
  engineDescriptor,
  InstanceKindSchema,
} from "@arriero/core";
import type { Hono } from "hono";

import {
  getArgumentCatalogAsync,
  getLlamaArgumentReferenceCatalog,
} from "../arguments/catalog.js";
import {
  getArgumentDefaults,
  saveArgumentDefaults,
} from "../arguments/defaults-repository.js";
import { generatedHelpChangedLines } from "../arguments/docs-source.js";
import { getLlamaArgumentDocsSyncReport } from "../arguments/docs-sync.js";
import {
  engineArgumentReferenceSummaries,
  getEngineArgumentReferenceCatalog,
  readEngineArgumentDoc,
} from "../arguments/engine-reference.js";
import {
  getEngineHelpSourceAdapter,
  listEngineHelpSourceAdapters,
} from "../arguments/help-source-adapters.js";
import { readArgumentEngineeringDoc } from "../arguments/docs.js";
import { parseJsonBody } from "./validation.js";

export function registerArgumentRoutes(app: Hono) {
  app.get("/api/llama-args", async (c) => {
    const kindParsed = InstanceKindSchema.safeParse(
      c.req.query("kind") ?? "llama-server",
    );
    if (!kindParsed.success) {
      return c.json(
        { error: `unknown instance kind: ${c.req.query("kind")}` },
        400,
      );
    }
    const parserId = engineDescriptor(kindParsed.data).preflight
      .argumentCatalogParser;
    if (parserId === "none") {
      return c.json(
        { error: `no argument catalog for instance kind ${kindParsed.data}` },
        400,
      );
    }
    try {
      return c.json({
        data: await getArgumentCatalogAsync(c.req.query("binaryPath"), {
          refresh: c.req.query("refresh") === "true",
          parserId,
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

  app.get("/api/llama-args/docs-sync", async (c) => {
    try {
      return c.json({
        data: await getLlamaArgumentDocsSyncReport(),
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

  app.get("/api/engine-args/help-sources", async (c) => {
    try {
      return c.json({
        data: await Promise.all(
          listEngineHelpSourceAdapters()
            .filter((adapter) => !adapter.coveredByDriftReport)
            .map((adapter) => adapter.sync()),
        ),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/api/engine-args/help-sources/:engineId", async (c) => {
    try {
      const adapter = getEngineHelpSourceAdapter(c.req.param("engineId"));
      return c.json({ data: await adapter.sync() });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/api/engine-args/help-sources/:engineId/diff", async (c) => {
    try {
      const adapter = getEngineHelpSourceAdapter(c.req.param("engineId"));
      return c.json({ data: { diff: await adapter.diff() } });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/api/engine-args/references", (c) => {
    return c.json({ data: engineArgumentReferenceSummaries() });
  });

  app.get("/api/engine-args/:engineId/reference", (c) => {
    try {
      return c.json({
        data: getEngineArgumentReferenceCatalog(c.req.param("engineId")),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/api/engine-args/:engineId/docs/:primaryName", (c) => {
    try {
      return c.json({
        data: readEngineArgumentDoc(
          c.req.param("engineId"),
          decodeURIComponent(c.req.param("primaryName")),
        ),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.get("/api/llama-args/defaults", (c) => {
    return c.json({ data: getArgumentDefaults() });
  });

  app.put("/api/llama-args/defaults", async (c) => {
    const body = await parseJsonBody(c, ArgumentDefaultsSchema);
    return c.json({ data: saveArgumentDefaults(body) });
  });
}
