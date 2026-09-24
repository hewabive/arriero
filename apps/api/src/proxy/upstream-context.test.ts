import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ApiProxyTargetRecordSchema,
  type InstanceModelSource,
  type Instance,
} from "@arriero/core";

import { createInstance, deleteInstance } from "../instances/repository.js";
import { instanceTestFixture } from "../instances/test-fixtures.js";
import { instanceEndpointId } from "./endpoints.js";
import {
  instanceMetricsLabelHeader,
  resolveApiProxyUpstreamContext,
} from "./upstream-context.js";

const fixture = instanceTestFixture("upstream-model");

for (const scenario of [
  {
    kind: "llama-server",
    args: { "--alias": "llama-local", "--model": "/models/llama.gguf" },
    expected: "llama-local",
  },
  {
    kind: "llama-server",
    args: { "--model": "/models/llama.gguf" },
    expected: "llama.gguf",
  },
  {
    kind: "llama-server",
    args: { "--models-preset": "/models/presets.ini" },
    expected: null,
  },
  {
    kind: "sglang",
    args: { "--served-model-name": "sglang-local" },
    expected: "sglang-local",
  },
  { kind: "vllm", args: {}, expected: null },
] satisfies (InstanceModelSource & { expected: string | null })[]) {
  test(`upstream model for ${scenario.kind} ${JSON.stringify(scenario.args)}`, (t) => {
    const instance = createInstance({
      name: fixture.uniqueName(scenario.kind),
      binaryPathRefId: fixture.seedBinaryRef(),
      kind: scenario.kind,
      args: scenario.args,
      env: {},
      rpcWorkers: [],
      memory: [],
    });
    t.after(() => deleteInstance(instance.name));
    const target = ApiProxyTargetRecordSchema.parse({
      id: "target",
      name: "target",
      endpointId: instanceEndpointId(instance.name),
      model: null,
    });
    for (const explicit of [null, "explicit-model"]) {
      const resolved = resolveApiProxyUpstreamContext({
        target: { ...target, model: explicit },
        operation: {
          protocol: "openai",
          endpoint: "chat.completions",
          routePath: "/v1/chat/completions",
          transport: "http-json",
        },
      });
      assert.ok(resolved.ok);
      assert.equal(
        resolved.context.modelOverride,
        explicit ?? scenario.expected,
      );
    }
    assert.equal(target.model, null);
  });
}

function instance(args: Instance["args"]): Instance {
  return {
    name: "kt-upstream",
    kind: "ktransformers",
    binaryPath: "/env/bin/sglang",
    binaryPathRefId: "kt-bin",
    args,
    env: {},
    memory: [],
    rpcWorkers: [],
    status: "stopped",
    pid: null,
  };
}

test("instanceMetricsLabelHeader is null without an instance or the argument", () => {
  assert.equal(instanceMetricsLabelHeader(null), null);
  assert.equal(instanceMetricsLabelHeader(instance({})), null);
});

test("instanceMetricsLabelHeader ignores the default header name", () => {
  assert.equal(
    instanceMetricsLabelHeader(
      instance({
        "--tokenizer-metrics-custom-labels-header": "x-custom-labels",
      }),
    ),
    null,
  );
  assert.equal(
    instanceMetricsLabelHeader(
      instance({
        "--tokenizer-metrics-custom-labels-header": "X-Custom-Labels",
      }),
    ),
    null,
  );
});

test("instanceMetricsLabelHeader lowercases a renamed header", () => {
  assert.equal(
    instanceMetricsLabelHeader(
      instance({
        "--tokenizer-metrics-custom-labels-header": "X-Tenant-Labels",
      }),
    ),
    "x-tenant-labels",
  );
});

test("instanceMetricsLabelHeader ignores non-string values", () => {
  assert.equal(
    instanceMetricsLabelHeader(
      instance({ "--tokenizer-metrics-custom-labels-header": true }),
    ),
    null,
  );
});
