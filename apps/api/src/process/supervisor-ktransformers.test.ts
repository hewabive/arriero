import type { Instance, ProcessPreflightResult } from "@arriero/core";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isPidAlive } from "./pid.js";
import { ProcessSupervisor } from "./supervisor.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

async function waitFor(
  predicate: () => boolean,
  attempts = 300,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return true;
    await tick();
  }
  return false;
}

test("KTransformers supervisor stops the complete detached worker tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "arriero-kt-supervisor-"));
  const binDir = join(root, "bin");
  const binary = join(binDir, "sglang");
  const python = join(binDir, "python");
  const childPidFile = join(root, "child.pid");
  mkdirSync(binDir);
  writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    python,
    [
      "#!/bin/sh",
      "sleep 30 &",
      "child=$!",
      'echo "$child" > "$KT_CHILD_PID_FILE"',
      "trap 'exit 0' TERM INT",
      'wait "$child"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const validPreflight = async (
    instance: Instance,
  ): Promise<ProcessPreflightResult> => ({
    instanceId: instance.name,
    ok: true,
    issues: [],
    checkedAt: new Date().toISOString(),
  });
  const manager = new ProcessSupervisor(validPreflight);
  const instance: Instance = {
    name: `kt-tree-${Date.now()}`,
    kind: "ktransformers",
    binaryPath: binary,
    binaryPathRefId: "kt-bin",
    cwd: root,
    args: {},
    env: { KT_CHILD_PID_FILE: childPidFile },
    memory: [],
    rpcWorkers: [],
    engineConfig: {
      type: "ktransformers",
      model: "owner/model",
      cpuWeights: root,
      method: "FP8",
    },
    scheduling: { evictionPolicy: "idle-only" },
    status: "stopped",
    pid: null,
  };

  try {
    await manager.start(instance);
    assert.equal(
      await waitFor(
        () =>
          manager.getState(instance.name)?.status === "running" &&
          existsSync(childPidFile),
      ),
      true,
    );
    const rootPid = manager.getState(instance.name)?.pid ?? 0;
    const childPid = Number(readFileSync(childPidFile, "utf8").trim());
    assert.equal(isPidAlive(rootPid), true);
    assert.equal(isPidAlive(childPid), true);

    manager.stop(instance.name, "operator", 1_000);
    assert.equal(
      await waitFor(() =>
        ["exited", "error"].includes(
          manager.getState(instance.name)?.status ?? "",
        ),
      ),
      true,
    );
    assert.equal(await waitFor(() => !isPidAlive(childPid)), true);
  } finally {
    await manager.shutdownAll(500);
    rmSync(root, { recursive: true, force: true });
  }
});
