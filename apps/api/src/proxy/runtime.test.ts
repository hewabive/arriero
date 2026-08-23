import type {
  ApiEndpointRecord,
  ApiProxyRuntimeMetadataRecord,
  ApiProxyTargetRecord,
  Instance,
  InstanceHealthSummary,
  EndpointProbe,
} from "@arriero/core";
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildApiProxyRuntimeSnapshot,
  resetApiProxyRuntimeTrackers,
  setApiProxySavedSlotIds,
} from "./runtime.js";

function endpoint(body: unknown, ok = true): EndpointProbe {
  return {
    ok,
    url: "http://127.0.0.1:8080/test",
    status: ok ? 200 : 500,
    latencyMs: 1,
    body,
  };
}

function instance(name = "instance-a"): Instance {
  return {
    name,
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
}

function target(
  input: {
    id?: string;
    endpointId?: string;
    model?: string | null;
  } = {},
): ApiProxyTargetRecord {
  return {
    id: input.id ?? "target-a",
    name: "Target A",
    endpointId: input.endpointId ?? "instance:instance-a",
    model: input.model === undefined ? "chat" : input.model,
    role: "interactive",
    priority: 100,
    preemptible: true,
    saveSlotsBeforeUnload: false,
    slotIds: [],
    idleUnloadMs: null,
  };
}

function apiEndpoint(
  input: {
    id?: string;
    baseUrl?: string;
    kind?: ApiEndpointRecord["kind"];
    instanceId?: string | null;
    nodeId?: string | null;
    enabled?: boolean;
  } = {},
): ApiEndpointRecord {
  return {
    id: input.id ?? "instance:instance-a",
    name: "Instance A",
    enabled: input.enabled ?? true,
    kind: input.kind ?? "managed-instance",
    baseUrl: input.baseUrl ?? "http://127.0.0.1:8080/v1",
    profile: "openai",
    reasoning: null,
    apiKeyEnvVar: null,
    authHeaderName: null,
    extraHeaders: {},
    passthrough: false,
    streamTerminal: null,
    modelFilter: null,
    authConfigured: false,
    instanceId:
      input.instanceId === undefined ? "instance-a" : input.instanceId,
    nodeId: input.nodeId ?? null,
    editable: false,
  };
}

function remoteEndpoint(): ApiEndpointRecord {
  return apiEndpoint({
    id: "remote:ny:remote-a",
    kind: "managed-instance",
    instanceId: "remote-a",
    nodeId: "ny",
  });
}

function health(
  input: {
    status?: InstanceHealthSummary["status"];
    healthOk?: boolean;
    healthStatus?: number | null;
    modelStatus?: string | null;
    processing?: boolean;
    canStart?: boolean;
    logErrors?: string[];
  } = {},
): InstanceHealthSummary {
  const slots = endpoint([{ id: 0, is_processing: input.processing ?? false }]);
  const healthEndpoint = endpoint({ status: "ok" }, input.healthOk ?? true);
  healthEndpoint.status = input.healthStatus ?? healthEndpoint.status;
  return {
    instanceId: "instance-a",
    status: input.status ?? "ready",
    reason: "test",
    actions: {
      canStart: input.canStart ?? false,
      canStop: true,
      canRestart: true,
    },
    runtime: {
      instanceId: "instance-a",
      pid: 100,
      status: "running",
      startedAt: "2026-05-30T10:00:00.000Z",
      stoppedAt: null,
      exitCode: null,
      logPath: null,
      rawLogPath: null,
    },
    preflight: {
      instanceId: "instance-a",
      ok: true,
      issues: [],
      checkedAt: "2026-05-30T10:00:00.000Z",
    },
    llama: {
      baseUrl: "http://127.0.0.1:8080",
      health: healthEndpoint,
      props: endpoint({}),
      slots,
      models: endpoint({
        data: [
          {
            id: "chat",
            ...(input.modelStatus === null
              ? {}
              : { status: { value: input.modelStatus ?? "loaded" } }),
          },
        ],
      }),
      modelDiagnostics: {},
    },
    logSummary: {
      instanceId: "instance-a",
      logPath: null,
      listeningUrl: null,
      modelPath: null,
      modelAlias: null,
      contextSize: null,
      gpuLayers: null,
      slots: null,
      ready: true,
      warnings: [],
      errors: input.logErrors ?? [],
      notices: [],
      loadProgress: {
        stage: "ready",
        percent: null,
        message: "ready",
        estimated: false,
      },
      memoryLayout: {
        source: "none",
        sourceDetail: null,
        processIds: [],
        entries: [],
        deviceBytes: 0,
        hostBytes: 0,
        otherBytes: 0,
        totalBytes: 0,
        projectedHostBytes: null,
        projectedHostTotalBytes: null,
      },
      updatedAt: "2026-05-30T10:00:00.000Z",
    },
    promptCache: null,
    configDrift: false,
    reasoningTemplateIssue: null,
    swapBytes: null,
    numaPlacement: null,
    checkedAt: "2026-05-30T10:00:00.000Z",
  };
}

test("buildApiProxyRuntimeSnapshot derives model runtime and tracks idle state", () => {
  resetApiProxyRuntimeTrackers();
  const proxyTarget = target();
  const proxyInstance = instance();
  const first = buildApiProxyRuntimeSnapshot({
    checkedAt: "2026-05-30T10:00:00.000Z",
    targets: [proxyTarget],
    endpoints: [apiEndpoint()],
    instances: [proxyInstance],
    healthByInstanceId: new Map([["instance-a", health()]]),
  });

  assert.equal(first.targets[0]?.state, "ready");
  assert.equal(first.targets[0]?.activeRequests, 0);
  assert.equal(first.targets[0]?.idleSince, "2026-05-30T10:00:00.000Z");

  const second = buildApiProxyRuntimeSnapshot({
    checkedAt: "2026-05-30T10:00:05.000Z",
    targets: [proxyTarget],
    endpoints: [apiEndpoint()],
    instances: [proxyInstance],
    healthByInstanceId: new Map([["instance-a", health()]]),
  });

  assert.equal(second.targets[0]?.idleSince, "2026-05-30T10:00:00.000Z");

  const busy = buildApiProxyRuntimeSnapshot({
    checkedAt: "2026-05-30T10:00:10.000Z",
    targets: [proxyTarget],
    endpoints: [apiEndpoint()],
    instances: [proxyInstance],
    healthByInstanceId: new Map([["instance-a", health({ processing: true })]]),
  });

  assert.equal(busy.targets[0]?.state, "ready");
  assert.equal(busy.targets[0]?.activeRequests, 1);
  assert.equal(busy.targets[0]?.idleSince, null);
  assert.equal(busy.targets[0]?.lastRequestAt, "2026-05-30T10:00:10.000Z");
});

test("buildApiProxyRuntimeSnapshot pins lastRequestAt while a request stays active", () => {
  resetApiProxyRuntimeTrackers();

  const first = buildApiProxyRuntimeSnapshot({
    checkedAt: "2026-05-30T10:00:10.000Z",
    targets: [target()],
    endpoints: [apiEndpoint()],
    instances: [instance()],
    healthByInstanceId: new Map([["instance-a", health({ processing: true })]]),
  });

  assert.equal(first.targets[0]?.state, "ready");
  assert.equal(first.targets[0]?.lastRequestAt, "2026-05-30T10:00:10.000Z");

  const later = buildApiProxyRuntimeSnapshot({
    checkedAt: "2026-05-30T10:00:15.000Z",
    targets: [target()],
    endpoints: [apiEndpoint()],
    instances: [instance()],
    healthByInstanceId: new Map([["instance-a", health({ processing: true })]]),
  });

  assert.equal(later.targets[0]?.state, "ready");
  assert.equal(later.targets[0]?.lastRequestAt, "2026-05-30T10:00:10.000Z");
});

test("buildApiProxyRuntimeSnapshot marks an in-flight lease busy during prefill", () => {
  resetApiProxyRuntimeTrackers();

  const snapshot = buildApiProxyRuntimeSnapshot({
    checkedAt: "2026-05-30T10:00:10.000Z",
    targets: [target()],
    endpoints: [apiEndpoint()],
    instances: [instance()],
    healthByInstanceId: new Map([
      ["instance-a", health({ processing: false })],
    ]),
    busyTargetIds: new Set(["target-a"]),
  });

  assert.equal(snapshot.targets[0]?.state, "ready");
  assert.equal(snapshot.targets[0]?.activeRequests, 1);
  assert.equal(snapshot.targets[0]?.idleSince, null);
  assert.equal(snapshot.targets[0]?.lastRequestAt, "2026-05-30T10:00:10.000Z");
});

test("buildApiProxyRuntimeSnapshot does not override loading state for an in-flight lease", () => {
  resetApiProxyRuntimeTrackers();

  const snapshot = buildApiProxyRuntimeSnapshot({
    checkedAt: "2026-05-30T10:00:10.000Z",
    targets: [target()],
    endpoints: [apiEndpoint()],
    instances: [instance()],
    healthByInstanceId: new Map([
      ["instance-a", health({ modelStatus: "loading" })],
    ]),
    busyTargetIds: new Set(["target-a"]),
  });

  assert.equal(snapshot.targets[0]?.state, "loading");
});

test("buildApiProxyRuntimeSnapshot treats listed models without status as idle", () => {
  resetApiProxyRuntimeTrackers();

  const snapshot = buildApiProxyRuntimeSnapshot({
    checkedAt: "2026-05-30T10:00:00.000Z",
    targets: [target()],
    endpoints: [apiEndpoint()],
    instances: [instance()],
    healthByInstanceId: new Map([
      [
        "instance-a",
        health({
          status: "stale",
          modelStatus: null,
        }),
      ],
    ]),
  });

  assert.equal(snapshot.targets[0]?.state, "ready");
});

test("buildApiProxyRuntimeSnapshot carries saved slot ids for scheduler planning", () => {
  resetApiProxyRuntimeTrackers();
  setApiProxySavedSlotIds("target-a", [0, 2]);

  const snapshot = buildApiProxyRuntimeSnapshot({
    checkedAt: "2026-05-30T10:00:00.000Z",
    targets: [target()],
    endpoints: [apiEndpoint()],
    instances: [instance()],
    healthByInstanceId: new Map([["instance-a", health()]]),
  });

  assert.deepEqual(snapshot.targets[0]?.savedSlotIds, [0, 2]);
});

test("buildApiProxyRuntimeSnapshot uses persisted saved slot ids", () => {
  resetApiProxyRuntimeTrackers();
  const metadata: ApiProxyRuntimeMetadataRecord = {
    targetId: "target-a",
    savedSlotIds: [3],
    updatedAt: "2026-05-30T09:59:01.000Z",
  };

  const snapshot = buildApiProxyRuntimeSnapshot({
    checkedAt: "2026-05-30T10:00:00.000Z",
    targets: [target()],
    endpoints: [apiEndpoint()],
    instances: [instance()],
    healthByInstanceId: new Map([["instance-a", health()]]),
    metadataByTargetId: new Map([["target-a", metadata]]),
  });

  assert.deepEqual(snapshot.targets[0]?.savedSlotIds, [3]);
});

test("buildApiProxyRuntimeSnapshot derives a remote target from its node health", () => {
  resetApiProxyRuntimeTrackers();

  const snapshot = buildApiProxyRuntimeSnapshot({
    checkedAt: "2026-05-30T10:00:00.000Z",
    targets: [target({ endpointId: "remote:ny:remote-a", model: null })],
    endpoints: [remoteEndpoint()],
    instances: [],
    healthByInstanceId: new Map(),
    remoteManagedTargetIds: new Set(["target-a"]),
    remoteHealthByTargetId: new Map([
      [
        "target-a",
        health({
          status: "error",
          canStart: true,
          logErrors: ["error: unknown argument: --model"],
        }),
      ],
    ]),
  });

  assert.equal(snapshot.targets[0]?.state, "error");
  assert.equal(snapshot.targets[0]?.instanceId, null);
  assert.equal(
    snapshot.targets[0]?.stateDetail,
    "test\nerror: unknown argument: --model",
  );
});

test("buildApiProxyRuntimeSnapshot reports a ready remote target as idle", () => {
  resetApiProxyRuntimeTrackers();

  const snapshot = buildApiProxyRuntimeSnapshot({
    checkedAt: "2026-05-30T10:00:00.000Z",
    targets: [target({ endpointId: "remote:ny:remote-a", model: null })],
    endpoints: [remoteEndpoint()],
    instances: [],
    healthByInstanceId: new Map(),
    remoteManagedTargetIds: new Set(["target-a"]),
    remoteHealthByTargetId: new Map([["target-a", health()]]),
  });

  assert.equal(snapshot.targets[0]?.state, "ready");
});

test("buildApiProxyRuntimeSnapshot reports an unreachable remote target as unknown", () => {
  resetApiProxyRuntimeTrackers();

  const snapshot = buildApiProxyRuntimeSnapshot({
    checkedAt: "2026-05-30T10:00:00.000Z",
    targets: [target({ endpointId: "remote:ny:remote-a", model: null })],
    endpoints: [remoteEndpoint()],
    instances: [],
    healthByInstanceId: new Map(),
    remoteManagedTargetIds: new Set(["target-a"]),
    remoteHealthByTargetId: new Map(),
  });

  assert.equal(snapshot.targets[0]?.state, "unknown");
});

test("buildApiProxyRuntimeSnapshot reports a disabled remote node as error", () => {
  resetApiProxyRuntimeTrackers();

  const snapshot = buildApiProxyRuntimeSnapshot({
    checkedAt: "2026-05-30T10:00:00.000Z",
    targets: [target({ endpointId: "remote:ny:remote-a", model: null })],
    endpoints: [
      apiEndpoint({
        id: "remote:ny:remote-a",
        kind: "managed-instance",
        instanceId: "remote-a",
        nodeId: "ny",
        enabled: false,
      }),
    ],
    instances: [],
    healthByInstanceId: new Map(),
    remoteManagedTargetIds: new Set(["target-a"]),
    remoteHealthByTargetId: new Map(),
  });

  assert.equal(snapshot.targets[0]?.state, "error");
});

test("buildApiProxyRuntimeSnapshot treats external endpoint as external API", () => {
  resetApiProxyRuntimeTrackers();

  const snapshot = buildApiProxyRuntimeSnapshot({
    checkedAt: "2026-05-30T10:00:00.000Z",
    targets: [target({ endpointId: "external-a" })],
    endpoints: [
      apiEndpoint({
        id: "external-a",
        kind: "external-api",
        instanceId: null,
        baseUrl: "http://127.0.0.1:9999/v1",
      }),
    ],
    instances: [],
    healthByInstanceId: new Map(),
  });

  assert.equal(snapshot.targets[0]?.state, "ready");
  assert.equal(snapshot.targets[0]?.kind, "external-api");
});

test("buildApiProxyRuntimeSnapshot treats startable previous errors as stopped", () => {
  resetApiProxyRuntimeTrackers();

  const snapshot = buildApiProxyRuntimeSnapshot({
    checkedAt: "2026-05-30T10:00:00.000Z",
    targets: [target({ model: null })],
    endpoints: [apiEndpoint()],
    instances: [instance()],
    healthByInstanceId: new Map([
      [
        "instance-a",
        health({
          status: "error",
          canStart: true,
        }),
      ],
    ]),
  });

  assert.equal(snapshot.targets[0]?.state, "stopped");
});

test("buildApiProxyRuntimeSnapshot reports failure detail for a failed model", () => {
  resetApiProxyRuntimeTrackers();

  const snapshot = buildApiProxyRuntimeSnapshot({
    checkedAt: "2026-05-30T10:00:00.000Z",
    targets: [target()],
    endpoints: [apiEndpoint()],
    instances: [instance()],
    healthByInstanceId: new Map([
      [
        "instance-a",
        health({
          modelStatus: "failed",
          logErrors: ["cuda out of memory"],
        }),
      ],
    ]),
  });

  assert.equal(snapshot.targets[0]?.state, "error");
  assert.equal(
    snapshot.targets[0]?.stateDetail,
    "model chat failed to load\ncuda out of memory",
  );
});

test("buildApiProxyRuntimeSnapshot reports health reason for a failed process target", () => {
  resetApiProxyRuntimeTrackers();

  const snapshot = buildApiProxyRuntimeSnapshot({
    checkedAt: "2026-05-30T10:00:00.000Z",
    targets: [target({ model: null })],
    endpoints: [apiEndpoint()],
    instances: [instance()],
    healthByInstanceId: new Map([
      [
        "instance-a",
        health({
          status: "error",
          canStart: false,
          logErrors: ["bind: address already in use"],
        }),
      ],
    ]),
  });

  assert.equal(snapshot.targets[0]?.state, "error");
  assert.equal(
    snapshot.targets[0]?.stateDetail,
    "test\nbind: address already in use",
  );
});

test("buildApiProxyRuntimeSnapshot reports resolution error for a disabled endpoint", () => {
  resetApiProxyRuntimeTrackers();

  const snapshot = buildApiProxyRuntimeSnapshot({
    checkedAt: "2026-05-30T10:00:00.000Z",
    targets: [target()],
    endpoints: [apiEndpoint({ enabled: false })],
    instances: [instance()],
    healthByInstanceId: new Map([["instance-a", health()]]),
  });

  assert.equal(snapshot.targets[0]?.state, "error");
  assert.equal(
    snapshot.targets[0]?.stateDetail,
    "API endpoint Instance A is disabled",
  );
});

test("buildApiProxyRuntimeSnapshot treats reachable stale process targets as idle", () => {
  resetApiProxyRuntimeTrackers();

  const snapshot = buildApiProxyRuntimeSnapshot({
    checkedAt: "2026-05-30T10:00:00.000Z",
    targets: [target({ model: null })],
    endpoints: [apiEndpoint()],
    instances: [instance()],
    healthByInstanceId: new Map([
      [
        "instance-a",
        health({
          status: "stale",
          healthOk: true,
        }),
      ],
    ]),
  });

  assert.equal(snapshot.targets[0]?.state, "ready");
  assert.equal(snapshot.targets[0]?.idleSince, "2026-05-30T10:00:00.000Z");
});
