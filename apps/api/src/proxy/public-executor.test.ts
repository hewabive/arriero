import assert from "node:assert/strict";
import test from "node:test";

import type {
  ApiProxyPlanPreview,
  ApiProxySchedulerAction,
  ApiProxyTargetRecord,
  Instance,
} from "@arriero/core";

import { executeApiProxyPublicMvpPlan } from "./public-executor.js";

const target: ApiProxyTargetRecord = {
  id: "target-a",
  name: "Target A",
  endpointId: "instance:instance-a",
  model: "chat",
  role: "interactive",
  priority: 100,
  preemptible: true,
  saveSlotsBeforeUnload: false,
  slotIds: [],
  idleUnloadMs: null,
};

const instance: Instance = {
  name: "Instance A",
  kind: "llama-server",
  rpcWorkers: [],
  binaryPath: "/tmp/llama-server",
  binaryPathRefId: "bin-a",
  args: {},
  env: {},
  memory: [],
  status: "running",
  pid: 100,
};

function action(
  type: ApiProxySchedulerAction["type"],
  slotId: number | null = null,
): ApiProxySchedulerAction {
  return {
    type,
    targetId: target.id,
    instanceId: instance.name,
    model: target.model,
    slotId,
    reason: "test",
  };
}

function preview(actions: ApiProxySchedulerAction[]): ApiProxyPlanPreview {
  return {
    checkedAt: "2026-05-30T10:00:00.000Z",
    runtime: {
      checkedAt: "2026-05-30T10:00:00.000Z",
      targets: [],
    },
    plan: {
      ok: true,
      mode: "request",
      requestedTargetId: target.id,
      blockingReason: null,
      preemptTargetIds: [],
      actions,
    },
  };
}

const readyPreview = preview([action("route-request")]);

function blockedPreview(): ApiProxyPlanPreview {
  return {
    checkedAt: "2026-05-30T10:00:00.000Z",
    runtime: { checkedAt: "2026-05-30T10:00:00.000Z", targets: [] },
    plan: {
      ok: false,
      mode: "request",
      requestedTargetId: target.id,
      blockingReason: "no preemptible models available to evict",
      preemptTargetIds: [],
      actions: [],
    },
  };
}

function executorDefaults(
  update: {
    initialPreview?: ApiProxyPlanPreview | undefined;
    previews?: ApiProxyPlanPreview[] | undefined;
    startInstance?: ((targetInstance: Instance) => unknown) | undefined;
    loadModel?:
      | ((targetInstance: Instance, model: string) => Promise<void>)
      | undefined;
    unloadModel?:
      | ((targetInstance: Instance, model: string) => Promise<void>)
      | undefined;
    stopInstance?: ((targetInstance: Instance) => unknown) | undefined;
    saveSlot?:
      | ((
          targetInstance: Instance,
          slotId: number,
          targetId: string,
        ) => Promise<void>)
      | undefined;
    restoreSlot?:
      | ((
          targetInstance: Instance,
          slotId: number,
          targetId: string,
        ) => Promise<void>)
      | undefined;
    onRestoreSlotFailed?:
      | ((targetId: string, slotId: number, message: string) => void)
      | undefined;
  } = {},
) {
  const previews = [...(update.previews ?? [])];
  return {
    target,
    initialPreview: update.initialPreview ?? readyPreview,
    getInstance: () => instance,
    startInstance: update.startInstance ?? (() => undefined),
    loadModel: update.loadModel ?? (async () => undefined),
    unloadModel: update.unloadModel,
    stopInstance: update.stopInstance,
    saveSlot: update.saveSlot,
    restoreSlot: update.restoreSlot,
    onRestoreSlotFailed: update.onRestoreSlotFailed,
    getPlanPreview: async () => previews.shift() ?? readyPreview,
    sleep: async () => undefined,
    options: {
      pollIntervalMs: 0,
      instanceReadyTimeoutMs: 1_000,
      modelReadyTimeoutMs: 1_000,
    },
  };
}

test("executeApiProxyPublicMvpPlan passes through ready route-only plan", async () => {
  const result = await executeApiProxyPublicMvpPlan(executorDefaults());

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.preview.plan.actions[0]?.type, "route-request");
  }
});

test("executeApiProxyPublicMvpPlan starts stopped instance and reaches ready plan", async () => {
  let starts = 0;
  const result = await executeApiProxyPublicMvpPlan(
    executorDefaults({
      initialPreview: preview([
        action("start-instance"),
        action("wait-instance-ready"),
        action("route-request"),
      ]),
      previews: [readyPreview],
      startInstance: () => {
        starts += 1;
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(starts, 1);
});

test("executeApiProxyPublicMvpPlan fails fast when a started instance crashes instead of becoming ready", async () => {
  let starts = 0;
  const result = await executeApiProxyPublicMvpPlan({
    ...executorDefaults({
      initialPreview: preview([
        action("start-instance"),
        action("wait-instance-ready"),
        action("route-request"),
      ]),
      previews: [
        preview([action("wait-instance-ready"), action("route-request")]),
        preview([
          action("start-instance"),
          action("wait-instance-ready"),
          action("route-request"),
        ]),
      ],
      startInstance: () => {
        starts += 1;
      },
    }),
    describeStartFailure: async () => "error: unknown argument: --model",
  });

  assert.equal(result.ok, false);
  assert.equal(starts, 1);
  if (!result.ok) {
    assert.equal(result.diagnostic.code, "arriero_proxy_instance_start_failed");
    assert.match(result.diagnostic.message, /unknown argument: --model/);
  }
});

test("executeApiProxyPublicMvpPlan loads model and waits until ready", async () => {
  const loaded: string[] = [];
  const result = await executeApiProxyPublicMvpPlan(
    executorDefaults({
      initialPreview: preview([
        action("load-model"),
        action("wait-model-ready"),
        action("route-request"),
      ]),
      previews: [
        preview([action("wait-model-ready"), action("route-request")]),
        readyPreview,
      ],
      loadModel: async (_targetInstance, model) => {
        loaded.push(model);
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(loaded, ["chat"]);
});

test("executeApiProxyPublicMvpPlan rejects unload-model without an unload callback", async () => {
  const result = await executeApiProxyPublicMvpPlan(
    executorDefaults({
      initialPreview: preview([
        action("unload-model"),
        action("route-request"),
      ]),
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostic.code, "arriero_proxy_action_unsupported");
  }
});

test("executeApiProxyPublicMvpPlan unloads a blocker then reaches ready plan", async () => {
  const unloaded: string[] = [];
  const result = await executeApiProxyPublicMvpPlan(
    executorDefaults({
      initialPreview: preview([
        action("unload-model"),
        action("route-request"),
      ]),
      previews: [readyPreview],
      unloadModel: async (_targetInstance, model) => {
        unloaded.push(model);
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(unloaded, ["chat"]);
});

test("executeApiProxyPublicMvpPlan stops a blocker instance then reaches ready plan", async () => {
  let stops = 0;
  const result = await executeApiProxyPublicMvpPlan(
    executorDefaults({
      initialPreview: preview([
        action("stop-instance"),
        action("route-request"),
      ]),
      previews: [readyPreview],
      stopInstance: () => {
        stops += 1;
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(stops, 1);
});

test("executeApiProxyPublicMvpPlan surfaces not-ready when stop-instance never frees the blocker", async () => {
  let stops = 0;
  const base = executorDefaults({
    initialPreview: preview([action("stop-instance"), action("route-request")]),
    stopInstance: () => {
      stops += 1;
    },
  });
  const stuckStopPlan = preview([
    action("stop-instance"),
    action("route-request"),
  ]);
  const result = await executeApiProxyPublicMvpPlan({
    ...base,
    getPlanPreview: async () => stuckStopPlan,
    options: { ...base.options, maxPasses: 4 },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostic.code, "arriero_proxy_target_not_ready");
  }
  assert.equal(stops, 4);
});

test("executeApiProxyPublicMvpPlan rejects save-slot without a save callback", async () => {
  const result = await executeApiProxyPublicMvpPlan(
    executorDefaults({
      initialPreview: preview([
        action("save-slot", 0),
        action("route-request"),
      ]),
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostic.code, "arriero_proxy_action_unsupported");
  }
});

test("executeApiProxyPublicMvpPlan saves a slot before reaching ready plan", async () => {
  const saved: Array<{ slotId: number; targetId: string }> = [];
  const result = await executeApiProxyPublicMvpPlan(
    executorDefaults({
      initialPreview: preview([
        action("save-slot", 0),
        action("route-request"),
      ]),
      previews: [readyPreview],
      saveSlot: async (_targetInstance, slotId, targetId) => {
        saved.push({ slotId, targetId });
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(saved, [{ slotId: 0, targetId: target.id }]);
});

test("executeApiProxyPublicMvpPlan restores a slot before reaching ready plan", async () => {
  const restored: number[] = [];
  const result = await executeApiProxyPublicMvpPlan(
    executorDefaults({
      initialPreview: preview([
        action("restore-slot", 2),
        action("route-request"),
      ]),
      previews: [readyPreview],
      restoreSlot: async (_targetInstance, slotId) => {
        restored.push(slotId);
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(restored, [2]);
});

test("executeApiProxyPublicMvpPlan drops a stale slot when restore fails, then reaches ready plan", async () => {
  const dropped: Array<{ targetId: string; slotId: number }> = [];
  const result = await executeApiProxyPublicMvpPlan(
    executorDefaults({
      initialPreview: preview([
        action("restore-slot", 0),
        action("route-request"),
      ]),
      previews: [readyPreview],
      restoreSlot: async () => {
        throw new Error("Unable to restore slot, invalid slot save file");
      },
      onRestoreSlotFailed: (targetId, slotId) => {
        dropped.push({ targetId, slotId });
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(dropped, [{ targetId: target.id, slotId: 0 }]);
});

test("executeApiProxyPublicMvpPlan surfaces a 502 when restore fails and no drop handler is wired", async () => {
  const result = await executeApiProxyPublicMvpPlan(
    executorDefaults({
      initialPreview: preview([
        action("restore-slot", 0),
        action("route-request"),
      ]),
      restoreSlot: async () => {
        throw new Error("Unable to restore slot, invalid slot save file");
      },
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostic.code, "arriero_proxy_upstream_error");
  }
});

test("executeApiProxyPublicMvpPlan waits out a transient block then routes", async () => {
  const result = await executeApiProxyPublicMvpPlan(
    executorDefaults({
      initialPreview: blockedPreview(),
      previews: [blockedPreview(), readyPreview],
    }),
  );

  assert.equal(result.ok, true);
});

test("executeApiProxyPublicMvpPlan stops waiting on a blocked plan when the client aborts", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await executeApiProxyPublicMvpPlan({
    ...executorDefaults({ initialPreview: blockedPreview() }),
    signal: controller.signal,
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? null : result.diagnostic.code,
    "arriero_proxy_plan_blocked",
  );
});
