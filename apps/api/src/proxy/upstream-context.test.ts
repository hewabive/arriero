import type { Instance } from "@arriero/core";
import assert from "node:assert/strict";
import test from "node:test";

import { instanceMetricsLabelHeader } from "./upstream-context.js";

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
