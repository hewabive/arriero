import type { Instance } from "@arriero/core";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
  getResidencyHealth,
  refreshResidencyHealth,
  resetResidencyHealthCache,
} from "./instance-health-cache.js";

function instance(input: Partial<Instance>): Instance {
  return {
    name: input.name ?? "residency-test",
    kind: input.kind ?? "llama-server",
    rpcWorkers: input.rpcWorkers ?? [],
    binaryPath: input.binaryPath ?? "/bin/sh",
    binaryPathRefId: input.binaryPathRefId ?? "test-binary",
    cwd: input.cwd ?? tmpdir(),
    args: input.args ?? {},
    env: {},
    memory: input.memory ?? [],
    status: input.status ?? "stopped",
    pid: input.pid ?? null,
  };
}

test("residency cache serves the stored value until refreshed", async () => {
  resetResidencyHealthCache();
  const inst = instance({ name: "residency-cache-a" });

  const first = await getResidencyHealth(inst, []);
  const cached = await getResidencyHealth(inst, []);
  assert.equal(cached, first);

  const refreshed = await getResidencyHealth(inst, [], { fresh: true });
  assert.notEqual(refreshed, first);

  const afterRefresh = await getResidencyHealth(inst, []);
  assert.equal(afterRefresh, refreshed);
});

test("refreshResidencyHealth prunes instances that are no longer targets", async () => {
  resetResidencyHealthCache();
  const inst = instance({ name: "residency-cache-b" });

  await refreshResidencyHealth([inst], [inst]);
  const warmed = await getResidencyHealth(inst, []);

  await refreshResidencyHealth([], []);
  const afterPrune = await getResidencyHealth(inst, []);
  assert.notEqual(afterPrune, warmed);
});
