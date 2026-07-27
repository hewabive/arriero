import {
  ApiProbeRequestSchema,
  LlamaModelActionRequestSchema,
  LlamaSlotActionRequestSchema,
  type EndpointProbe,
} from "@arriero/core";
import type { Hono } from "hono";

import {
  isStreamingProbeKind,
  streamApiProbeTarget,
} from "../api-lab/stream.js";
import { getInstance } from "../instances/repository.js";
import {
  instanceApiProbeTarget,
  llamaEndpointErrorMessage,
  probeLlamaCapabilities,
  probeLlamaServer,
  requestInstanceApiProbe,
  requestLlamaModelAction,
  requestLlamaSlotAction,
} from "../llama/probe.js";

function llamaActionHttpStatus(probe: EndpointProbe) {
  if (probe.status && probe.status >= 400 && probe.status < 500) {
    return 400;
  }
  return 502;
}

export function registerInstanceLlamaRoutes(app: Hono) {
  app.get("/api/instances/:id/llama", async (c) => {
    const instance = getInstance(c.req.param("id"));
    if (!instance) {
      return c.json({ error: "instance not found" }, 404);
    }

    return c.json({ data: await probeLlamaServer(instance) });
  });

  app.get("/api/instances/:id/llama/capabilities", async (c) => {
    const instance = getInstance(c.req.param("id"));
    if (!instance) {
      return c.json({ error: "instance not found" }, 404);
    }

    const force = c.req.query("refresh") === "true";
    try {
      return c.json({
        data: await probeLlamaCapabilities(instance, { force }),
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.post("/api/instances/:id/llama/probe", async (c) => {
    const parsed = ApiProbeRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const instance = getInstance(c.req.param("id"));
    if (!instance) {
      return c.json({ error: "instance not found" }, 404);
    }

    try {
      const data = await requestInstanceApiProbe(instance, parsed.data);
      return c.json({ data });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.post("/api/instances/:id/llama/probe/stream", async (c) => {
    const parsed = ApiProbeRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    if (!isStreamingProbeKind(parsed.data.kind)) {
      return c.json(
        { error: "streaming is only supported for generation probes" },
        400,
      );
    }

    const instance = getInstance(c.req.param("id"));
    if (!instance) {
      return c.json({ error: "instance not found" }, 404);
    }

    let target: ReturnType<typeof instanceApiProbeTarget>;
    try {
      target = instanceApiProbeTarget(instance, parsed.data, { stream: true });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }

    return streamApiProbeTarget(c, {
      request: parsed.data,
      target,
    });
  });

  app.post("/api/instances/:id/llama/models/reload", async (c) => {
    const instance = getInstance(c.req.param("id"));
    if (!instance) {
      return c.json({ error: "instance not found" }, 404);
    }

    try {
      const result = await requestLlamaModelAction(instance, "reload");
      if (!result.response.ok) {
        return c.json(
          { error: llamaEndpointErrorMessage(result.response), data: result },
          llamaActionHttpStatus(result.response),
        );
      }
      return c.json({ data: result });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.post("/api/instances/:id/llama/models/:action", async (c) => {
    const action = c.req.param("action");
    if (action !== "load" && action !== "unload") {
      return c.json({ error: "unsupported model action" }, 404);
    }

    const parsed = LlamaModelActionRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const instance = getInstance(c.req.param("id"));
    if (!instance) {
      return c.json({ error: "instance not found" }, 404);
    }

    try {
      const result = await requestLlamaModelAction(
        instance,
        action,
        parsed.data.model,
      );
      if (!result.response.ok) {
        return c.json(
          { error: llamaEndpointErrorMessage(result.response), data: result },
          llamaActionHttpStatus(result.response),
        );
      }
      return c.json({ data: result });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.post("/api/instances/:id/llama/slots/:slotId/:action", async (c) => {
    const action = c.req.param("action");
    if (action !== "save" && action !== "restore" && action !== "erase") {
      return c.json({ error: "unsupported slot action" }, 404);
    }

    const slotId = Number(c.req.param("slotId"));
    if (!Number.isInteger(slotId) || slotId < 0) {
      return c.json({ error: "invalid slot id" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = LlamaSlotActionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    if ((action === "save" || action === "restore") && !parsed.data.filename) {
      return c.json({ error: "filename is required" }, 400);
    }

    const instance = getInstance(c.req.param("id"));
    if (!instance) {
      return c.json({ error: "instance not found" }, 404);
    }

    try {
      const result = await requestLlamaSlotAction(
        instance,
        action,
        slotId,
        parsed.data,
      );
      if (!result.response.ok) {
        return c.json(
          { error: llamaEndpointErrorMessage(result.response), data: result },
          llamaActionHttpStatus(result.response),
        );
      }
      return c.json({ data: result });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });
}
