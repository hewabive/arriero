import assert from "node:assert/strict";
import test from "node:test";

import { vllmLogParser } from "./vllm.js";

test("vllm parser recognizes weight loading and readiness", () => {
  const loading = vllmLogParser.parse({
    lines: ["(EngineCore pid=2) Loading model weights: 42%"],
    cudaDevicesDisabled: false,
  });
  assert.equal(loading.loadProgress.stage, "tensors");
  assert.equal(loading.loadProgress.percent, 42);

  const ready = vllmLogParser.parse({
    lines: ["(APIServer pid=1) INFO: Application startup complete."],
    cudaDevicesDisabled: false,
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.loadProgress.stage, "ready");
});
