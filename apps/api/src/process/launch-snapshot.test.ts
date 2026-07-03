import type { Instance } from "@llama-manager/core";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import { config } from "../config.js";
import {
  buildLaunchSnapshot,
  hasLaunchSnapshotDrift,
  managedSlotSavePath,
  parseLaunchSnapshot,
  serializeLaunchSnapshot,
} from "./launch-snapshot.js";

function slotSavePathArg(cliArgs: string[]): string | null {
  const index = cliArgs.indexOf("--slot-save-path");
  return index >= 0 ? (cliArgs[index + 1] ?? null) : null;
}

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    name: "test-instance",
    kind: "llama-server",
    binaryPath: "/opt/llama/llama-server",
    status: "stopped",
    pid: null,
    args: { "--port": "8080", "--flash-attn": true },
    env: { CUDA_VISIBLE_DEVICES: "0" },
    rpcWorkers: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Instance;
}

test("launch snapshot round-trips through serialization", () => {
  const snapshot = buildLaunchSnapshot(makeInstance());
  const parsed = parseLaunchSnapshot(serializeLaunchSnapshot(snapshot));
  assert.deepEqual(parsed, snapshot);
});

test("parseLaunchSnapshot rejects malformed input", () => {
  assert.equal(parseLaunchSnapshot(null), null);
  assert.equal(parseLaunchSnapshot("not json"), null);
  assert.equal(parseLaunchSnapshot('{"cliArgs": []}'), null);
});

test("hasLaunchSnapshotDrift is false for an unchanged instance", () => {
  const instance = makeInstance();
  const snapshot = buildLaunchSnapshot(instance);
  assert.equal(hasLaunchSnapshotDrift(instance, snapshot), false);
});

test("hasLaunchSnapshotDrift detects args, env, binary and cwd changes", () => {
  const snapshot = buildLaunchSnapshot(makeInstance());
  assert.equal(
    hasLaunchSnapshotDrift(
      makeInstance({ args: { "--port": "8081", "--flash-attn": true } }),
      snapshot,
    ),
    true,
  );
  assert.equal(
    hasLaunchSnapshotDrift(
      makeInstance({ env: { CUDA_VISIBLE_DEVICES: "1" } }),
      snapshot,
    ),
    true,
  );
  assert.equal(
    hasLaunchSnapshotDrift(
      makeInstance({ binaryPath: "/opt/other/llama-server" }),
      snapshot,
    ),
    true,
  );
  assert.equal(
    hasLaunchSnapshotDrift(makeInstance({ cwd: "/tmp" }), snapshot),
    true,
  );
  assert.equal(
    hasLaunchSnapshotDrift(
      makeInstance({ rpcWorkers: [{ nodeId: null, instanceName: "w1" }] }),
      snapshot,
    ),
    true,
  );
});

test("buildLaunchSnapshot injects --slot-save-path for a single llama-server instance", () => {
  const instance = makeInstance({ kind: "llama-server" });
  const snapshot = buildLaunchSnapshot(instance);
  assert.equal(
    slotSavePathArg(snapshot.cliArgs),
    resolve(config.slotsDir, "test-instance"),
  );
});

test("managedSlotSavePath skips router instances", () => {
  const instance = makeInstance({
    kind: "llama-server",
    args: { "--models-preset": "default.ini" },
  });
  assert.equal(managedSlotSavePath(instance), null);
  assert.equal(slotSavePathArg(buildLaunchSnapshot(instance).cliArgs), null);
});

test("managedSlotSavePath skips rpc-worker instances", () => {
  const instance = makeInstance({ kind: "rpc-worker" });
  assert.equal(managedSlotSavePath(instance), null);
});

test("an explicit --slot-save-path is preserved, not overridden", () => {
  const instance = makeInstance({
    kind: "llama-server",
    args: { "--slot-save-path": "/custom/slots" },
  });
  assert.equal(managedSlotSavePath(instance), null);
  assert.equal(
    slotSavePathArg(buildLaunchSnapshot(instance).cliArgs),
    "/custom/slots",
  );
});

test("an injected --slot-save-path does not cause config drift", () => {
  const instance = makeInstance({ kind: "llama-server" });
  const snapshot = buildLaunchSnapshot(instance);
  assert.equal(hasLaunchSnapshotDrift(instance, snapshot), false);
});
