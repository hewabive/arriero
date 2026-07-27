import { strict as assert } from "node:assert";
import test from "node:test";

import {
  InstanceConfigRecordSchema,
  InstanceCreateSchema,
  InstanceUpdateSchema,
} from "@arriero/core";

test("InstanceCreateSchema defaults missing args and env", () => {
  const parsed = InstanceCreateSchema.parse({
    name: "test",
    binaryPathRefId: "bin-1",
  });

  assert.deepEqual(parsed.args, {});
  assert.deepEqual(parsed.env, {});
});

test("InstanceCreateSchema requires a binary catalog reference", () => {
  assert.equal(InstanceCreateSchema.safeParse({ name: "test" }).success, false);
});

test("InstanceUpdateSchema keeps omitted args and env undefined", () => {
  const parsed = InstanceUpdateSchema.parse({
    name: "renamed",
  });

  assert.equal(Object.hasOwn(parsed, "args"), false);
  assert.equal(Object.hasOwn(parsed, "env"), false);
  assert.equal(parsed.args, undefined);
  assert.equal(parsed.env, undefined);
});

const ktransformersEngineConfig = {
  type: "ktransformers" as const,
  model: "deepseek-ai/DeepSeek-V3",
  cpuWeights: "/models/deepseek-v3-kt",
  method: "AMXINT4" as const,
  servedModelName: "deepseek-v3",
};

test("KTransformers create config round-trips through the typed schema", () => {
  const parsed = InstanceCreateSchema.parse({
    name: "kt",
    kind: "ktransformers",
    binaryPathRefId: "bin-kt",
    engineConfig: ktransformersEngineConfig,
  });
  assert.deepEqual(parsed.engineConfig, ktransformersEngineConfig);
});

test("KTransformers requires matching typed config", () => {
  assert.equal(
    InstanceCreateSchema.safeParse({
      name: "kt",
      kind: "ktransformers",
      binaryPathRefId: "bin-kt",
    }).success,
    false,
  );
  assert.equal(
    InstanceCreateSchema.safeParse({
      name: "llama",
      kind: "llama-server",
      binaryPathRefId: "bin-llama",
      engineConfig: ktransformersEngineConfig,
    }).success,
    false,
  );
});

test("KTransformers rejects raw arguments owned by typed config", () => {
  for (const key of [
    "--model",
    "--model-path",
    "--kt-weight-path",
    "--kt-method",
    "--served-model-name",
  ]) {
    const parsed = InstanceCreateSchema.safeParse({
      name: "kt",
      kind: "ktransformers",
      binaryPathRefId: "bin-kt",
      engineConfig: ktransformersEngineConfig,
      args: { [key]: "duplicate" },
    });
    assert.equal(parsed.success, false, key);
  }
});

test("stored KTransformers records validate kind and reserved arguments", () => {
  const base = {
    name: "kt",
    kind: "ktransformers" as const,
    binaryPath: "/opt/kt/bin/sglang",
    binaryPathRefId: "bin-kt",
    args: {},
    env: {},
    memory: [],
    rpcWorkers: [],
    engineConfig: ktransformersEngineConfig,
    scheduling: { evictionPolicy: "idle-only" as const },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(InstanceConfigRecordSchema.safeParse(base).success, true);
  assert.equal(
    InstanceConfigRecordSchema.safeParse({
      ...base,
      args: { "--kt-method": "BF16" },
    }).success,
    false,
  );
});
