import {
  ConfigGitCheckoutCommitSchema,
  ConfigGitCloneSchema,
  ConfigGitCommitInputSchema,
  ConfigGitCreateBranchSchema,
  ConfigGitInitSchema,
  ConfigGitRemoteSchema,
  ConfigGitResetSchema,
  ConfigGitRestoreFilesSchema,
  ConfigGitSwitchSchema,
} from "@arriero/core";
import type { Context, Hono } from "hono";

import {
  checkoutConfigCommit,
  cloneConfigRepository,
  commitConfigChanges,
  createConfigBranch,
  fetchConfigRepository,
  initConfigRepository,
  pullConfigRepository,
  pushConfigRepository,
  resetConfigChanges,
  restoreConfigFiles,
  setConfigRemote,
  switchConfigBranch,
} from "../config-git/operations.js";
import {
  getConfigGitCommit,
  getConfigGitDiff,
  getConfigGitLog,
  getConfigGitStatus,
} from "../config-git/repository.js";
import { validateConfigRoot } from "../config-git/validation.js";
import { config } from "../config.js";

async function input(c: Context) {
  return c.req.json().catch(() => ({}));
}

function failure(c: Context, error: unknown) {
  const message = (error as Error).message;
  if (
    /already running|while a build|while an environment|while a source|stop managed/.test(
      message,
    )
  ) {
    return c.json({ error: message }, 409);
  }
  return c.json({ error: message }, 400);
}

export function registerConfigGitRoutes(app: Hono) {
  app.get("/api/config-git/status", async (c) => {
    return c.json({ data: await getConfigGitStatus() });
  });

  app.get("/api/config-git/validation", (c) => {
    return c.json({ data: validateConfigRoot(config.configDir) });
  });

  app.get("/api/config-git/diff", async (c) => {
    try {
      return c.json({ data: await getConfigGitDiff(c.req.query("path")) });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.get("/api/config-git/log", async (c) => {
    try {
      const limit = Number(c.req.query("limit") ?? "50");
      return c.json({
        data: await getConfigGitLog(Number.isFinite(limit) ? limit : 50),
      });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.get("/api/config-git/commits/:commit", async (c) => {
    try {
      return c.json({ data: await getConfigGitCommit(c.req.param("commit")) });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post("/api/config-git/init", async (c) => {
    const parsed = ConfigGitInitSchema.safeParse(await input(c));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json({ data: await initConfigRepository(parsed.data) }, 201);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post("/api/config-git/remote", async (c) => {
    const parsed = ConfigGitRemoteSchema.safeParse(await input(c));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json({ data: await setConfigRemote(parsed.data) });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post("/api/config-git/clone", async (c) => {
    const parsed = ConfigGitCloneSchema.safeParse(await input(c));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json({ data: await cloneConfigRepository(parsed.data) }, 201);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post("/api/config-git/fetch", async (c) => {
    try {
      return c.json({ data: await fetchConfigRepository() });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post("/api/config-git/pull", async (c) => {
    try {
      return c.json({ data: await pullConfigRepository() });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post("/api/config-git/switch", async (c) => {
    const parsed = ConfigGitSwitchSchema.safeParse(await input(c));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json({ data: await switchConfigBranch(parsed.data) });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post("/api/config-git/branches", async (c) => {
    const parsed = ConfigGitCreateBranchSchema.safeParse(await input(c));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json({ data: await createConfigBranch(parsed.data) }, 201);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post("/api/config-git/checkout", async (c) => {
    const parsed = ConfigGitCheckoutCommitSchema.safeParse(await input(c));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json({ data: await checkoutConfigCommit(parsed.data) });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post("/api/config-git/restore-files", async (c) => {
    const parsed = ConfigGitRestoreFilesSchema.safeParse(await input(c));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json({ data: await restoreConfigFiles(parsed.data) });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post("/api/config-git/reset", async (c) => {
    const parsed = ConfigGitResetSchema.safeParse(await input(c));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json({ data: await resetConfigChanges(parsed.data) });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post("/api/config-git/commit", async (c) => {
    const parsed = ConfigGitCommitInputSchema.safeParse(await input(c));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      return c.json({ data: await commitConfigChanges(parsed.data) }, 201);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post("/api/config-git/push", async (c) => {
    try {
      return c.json({ data: await pushConfigRepository() });
    } catch (error) {
      return failure(c, error);
    }
  });
}
