import { PrerequisiteInstallStartSchema } from "@arriero/core";
import type { Hono } from "hono";

import { resetUvToolStatusCache } from "../envs/uv.js";
import { resetNumaInterleaveCache } from "../numa/capability.js";
import { resolveInstallCommand } from "../prerequisites/install-plan.js";
import { prerequisiteInstallRunner } from "../prerequisites/install-runner.js";
import { prerequisiteRebootState } from "../prerequisites/reboot-state.js";
import { findPrerequisiteDefinition } from "../prerequisites/registry.js";
import { getPrerequisiteReport } from "../prerequisites/report.js";

export function registerPrerequisiteRoutes(app: Hono) {
  app.get("/api/prerequisites", async (c) => {
    resetUvToolStatusCache();
    resetNumaInterleaveCache();
    return c.json({ data: await getPrerequisiteReport() });
  });

  app.get("/api/prerequisites/install/latest", (c) => {
    return c.json({ data: prerequisiteInstallRunner.latest() });
  });

  app.post("/api/prerequisites/install", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = PrerequisiteInstallStartSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    if (prerequisiteInstallRunner.isRunning()) {
      return c.json(
        { error: "a package installation is already running" },
        409,
      );
    }
    resetUvToolStatusCache();
    resetNumaInterleaveCache();
    const report = await getPrerequisiteReport();
    if (!report.installRunner.available) {
      return c.json(
        {
          error:
            report.installRunner.reason ??
            "the manager cannot elevate privileges non-interactively",
        },
        400,
      );
    }
    const command = resolveInstallCommand(report, parsed.data);
    if (!command) {
      return c.json(
        { error: "no package install command for this selection" },
        400,
      );
    }
    try {
      const rebootCheckId =
        "checkId" in parsed.data &&
        findPrerequisiteDefinition(parsed.data.checkId)
          ?.requiresRebootAfterInstall
          ? parsed.data.checkId
          : null;
      const run = prerequisiteInstallRunner.start(
        parsed.data,
        command,
        report.installRunner.method,
        rebootCheckId
          ? {
              onSucceeded: () =>
                prerequisiteRebootState.markPending(rebootCheckId),
            }
          : {},
      );
      return c.json({ data: run }, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 409);
    }
  });
}
