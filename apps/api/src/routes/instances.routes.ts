import {
  InstanceCreateSchema,
  InstancePreflightPreviewSchema,
  InstanceUpdateSchema,
  type Instance,
  type InstanceKind,
  type InstanceMemoryDraw,
  type RpcWorkerRef,
} from "@arriero/core";
import type { Hono } from "hono";

import { admitInstanceDraw } from "../resources/ledger.js";
import { getMemoryPool } from "../resources/repository.js";

import {
  InstanceConfigValidationError,
  InstanceNameConflictError,
  createInstance,
  deleteInstance,
  getInstance,
  listInstances,
  updateInstance,
} from "../instances/repository.js";
import { instanceResourceProfiles } from "../instances/resource-profile.js";
import { getPathCatalogEntry } from "../path-catalog/repository.js";
import { getInstanceHealthSummary } from "../process/health-summary.js";
import {
  instanceCudaDevicesDisabled,
  summarizeInstanceLog,
} from "../process/log-summary.js";
import { tailInstanceLog } from "../process/logs.js";
import { validateInstanceStartPreflight } from "../process/preflight.js";
import { latestProcessRun } from "../process/runs-repository.js";
import { stopStaleProcess } from "../process/stale.js";
import { supervisor } from "../process/supervisor.js";

function resolveInstancePathRefs(instance: Instance): Instance {
  const binaryRef = instance.binaryPathRefId
    ? getPathCatalogEntry(instance.binaryPathRefId)
    : null;

  return {
    ...instance,
    binaryPath: binaryRef?.path ?? "",
  };
}

function validateInstancePathRefs(input: {
  binaryPathRefId?: string | null | undefined;
  kind?: InstanceKind | undefined;
}) {
  if (input.binaryPathRefId) {
    const entry = getPathCatalogEntry(input.binaryPathRefId);
    if (!entry) return "binary path catalog entry not found";
    if (entry.kind !== "binary") return "binary path reference is not a binary";
    if (input.kind && entry.engineKind && entry.engineKind !== input.kind) {
      return `binary is tagged for ${entry.engineKind}, not ${input.kind}`;
    }
  }
  return null;
}

function validateInstanceMemoryRefs(input: {
  memory?: InstanceMemoryDraw[] | undefined;
}) {
  for (const draw of input.memory ?? []) {
    if (!getMemoryPool(draw.poolId)) {
      return `memory pool not found: ${draw.poolId}`;
    }
  }
  return null;
}

function validateInstanceRpcWorkers(input: {
  kind?: InstanceKind | undefined;
  rpcWorkers?: RpcWorkerRef[] | undefined;
}) {
  if (
    input.kind === "rpc-worker" &&
    input.rpcWorkers &&
    input.rpcWorkers.length > 0
  ) {
    return "rpc-worker instances cannot reference other rpc workers";
  }
  return null;
}

export function registerInstanceRoutes(app: Hono) {
  app.get("/api/instances", (c) => {
    return c.json({ data: listInstances() });
  });

  app.get("/api/instances/resource-profiles", (c) => {
    return c.json({ data: instanceResourceProfiles(listInstances()) });
  });

  app.get("/api/instances/health-summary", async (c) => {
    const instances = listInstances();
    return c.json({
      data: await Promise.all(
        instances.map((instance) =>
          getInstanceHealthSummary(instance, { peers: instances }),
        ),
      ),
    });
  });

  app.post("/api/instances", async (c) => {
    const parsed = InstanceCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const refError =
      validateInstancePathRefs(parsed.data) ??
      validateInstanceMemoryRefs(parsed.data) ??
      validateInstanceRpcWorkers(parsed.data);
    if (refError) {
      return c.json({ error: refError }, 400);
    }
    try {
      return c.json({ data: createInstance(parsed.data) }, 201);
    } catch (error) {
      if (error instanceof InstanceNameConflictError) {
        return c.json({ error: error.message }, 409);
      }
      if (error instanceof InstanceConfigValidationError) {
        return c.json({ error: error.details }, 400);
      }
      throw error;
    }
  });

  app.post("/api/instances/preflight", async (c) => {
    const parsed = InstancePreflightPreviewSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const refError = validateInstancePathRefs(parsed.data);
    if (refError) {
      return c.json({ error: refError }, 400);
    }

    const preview = parsed.data;
    const instance = resolveInstancePathRefs({
      name: preview.name ?? "preview",
      kind: preview.kind,
      binaryPath: "",
      binaryPathRefId: preview.binaryPathRefId,
      cwd: preview.cwd,
      args: preview.args,
      env: preview.env,
      memory: preview.memory,
      rpcWorkers: preview.rpcWorkers,
      ...(preview.numa !== undefined ? { numa: preview.numa } : {}),
      ...(preview.engineConfig !== undefined
        ? { engineConfig: preview.engineConfig }
        : {}),
      scheduling: preview.scheduling,
      status: "stopped",
      pid: null,
    });
    return c.json({
      data: await validateInstanceStartPreflight(instance, {
        peers: listInstances(),
        allowActiveSelfPort: Boolean(preview.name),
        capacityAdmission: admitInstanceDraw(instance.memory, {
          excludeInstanceId: instance.name,
        }),
      }),
    });
  });

  app.get("/api/instances/:id", (c) => {
    const instance = getInstance(c.req.param("id"));
    if (!instance) {
      return c.json({ error: "instance not found" }, 404);
    }
    return c.json({ data: instance });
  });

  app.get("/api/instances/:id/runtime", (c) => {
    const instance = getInstance(c.req.param("id"));
    if (!instance) {
      return c.json({ error: "instance not found" }, 404);
    }

    const latestRun = latestProcessRun(instance.name);
    const fallbackPid = latestRun?.pid ? Number(latestRun.pid) : null;
    return c.json({
      data: supervisor.getState(instance.name) ?? {
        instanceId: instance.name,
        pid: fallbackPid && Number.isFinite(fallbackPid) ? fallbackPid : null,
        status: latestRun?.status ?? instance.status,
        startedAt: latestRun?.startedAt ?? null,
        stoppedAt: latestRun?.stoppedAt ?? null,
        exitCode:
          latestRun?.exitCode === null || latestRun?.exitCode === undefined
            ? null
            : Number(latestRun.exitCode),
        logPath: latestRun?.logPath ?? null,
        rawLogPath: latestRun?.rawLogPath ?? null,
      },
    });
  });

  app.get("/api/instances/:id/preflight", async (c) => {
    const instance = getInstance(c.req.param("id"));
    if (!instance) {
      return c.json({ error: "instance not found" }, 404);
    }

    return c.json({
      data: await validateInstanceStartPreflight(instance, {
        peers: listInstances(),
        allowActiveSelfPort: true,
        capacityAdmission: admitInstanceDraw(instance.memory, {
          excludeInstanceId: instance.name,
        }),
      }),
    });
  });

  app.get("/api/instances/:id/health-summary", async (c) => {
    const instance = getInstance(c.req.param("id"));
    if (!instance) {
      return c.json({ error: "instance not found" }, 404);
    }

    return c.json({
      data: await getInstanceHealthSummary(instance, {
        peers: listInstances(),
      }),
    });
  });

  app.get("/api/instances/:id/logs", (c) => {
    const instance = getInstance(c.req.param("id"));
    if (!instance) {
      return c.json({ error: "instance not found" }, 404);
    }

    const lines = Number(c.req.query("lines") ?? "200");
    const source = c.req.query("source") === "raw" ? "raw" : "filtered";
    return c.json({
      data: tailInstanceLog({
        instanceId: instance.name,
        runtime: supervisor.getState(instance.name),
        lines: Number.isFinite(lines) ? lines : 200,
        source,
      }),
    });
  });

  app.get("/api/instances/:id/status-summary", async (c) => {
    const instance = getInstance(c.req.param("id"));
    if (!instance) {
      return c.json({ error: "instance not found" }, 404);
    }

    return c.json({
      data: await summarizeInstanceLog({
        instanceId: instance.name,
        kind: instance.kind,
        runtime: supervisor.getState(instance.name),
        cudaDevicesDisabled: instanceCudaDevicesDisabled(instance),
      }),
    });
  });

  app.patch("/api/instances/:id", async (c) => {
    const parsed = InstanceUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const current = getInstance(c.req.param("id"));
    const refError =
      validateInstancePathRefs({ ...parsed.data, kind: current?.kind }) ??
      validateInstanceMemoryRefs(parsed.data);
    if (refError) {
      return c.json({ error: refError }, 400);
    }
    try {
      const instance = updateInstance(c.req.param("id"), parsed.data);
      if (!instance) {
        return c.json({ error: "instance not found" }, 404);
      }
      return c.json({ data: instance });
    } catch (error) {
      if (error instanceof InstanceNameConflictError) {
        return c.json({ error: error.message }, 409);
      }
      if (error instanceof InstanceConfigValidationError) {
        return c.json({ error: error.details }, 400);
      }
      throw error;
    }
  });

  app.delete("/api/instances/:id", async (c) => {
    const id = c.req.param("id");
    supervisor.stop(id, 2_000);
    try {
      await stopStaleProcess(id, 2_000);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    const deleted = deleteInstance(id);
    return c.json({ data: { deleted } }, deleted ? 200 : 404);
  });
}
