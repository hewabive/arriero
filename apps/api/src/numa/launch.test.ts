import type { Instance, NumaNode } from "@arriero/core";
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  buildInterleaveArgs,
  interleaveSpec,
  resolveNumaLaunch,
} from "./launch.js";

function instance(numa?: Instance["numa"]): Instance {
  return { name: "srv", numa } as unknown as Instance;
}

function node(id: number): NumaNode {
  return {
    id,
    cpus: "0-3",
    cpuCount: 4,
    memoryBytes: 0,
    memFreeBytes: 0,
    filePagesBytes: 0,
    online: true,
  };
}

test("resolveNumaLaunch passes through when there is no numa config", () => {
  assert.deepEqual(resolveNumaLaunch(instance(), "/bin/llama", ["--a", "1"]), {
    binary: "/bin/llama",
    args: ["--a", "1"],
    cgroupDir: null,
  });
});

test("resolveNumaLaunch ignores stored numa config on a single-node host", () => {
  const expected = {
    binary: "/bin/llama",
    args: ["--a", "1"],
    cgroupDir: null,
  };
  assert.deepEqual(
    resolveNumaLaunch(
      instance({ mode: "bind", node: 1 }),
      "/bin/llama",
      ["--a", "1"],
      [node(0)],
    ),
    expected,
  );
  assert.deepEqual(
    resolveNumaLaunch(
      instance({ mode: "interleave", nodes: [0, 1] }),
      "/bin/llama",
      ["--a", "1"],
      [node(0)],
    ),
    expected,
  );
  assert.deepEqual(
    resolveNumaLaunch(
      instance({ mode: "bind", node: 0 }),
      "/bin/llama",
      ["--a", "1"],
      [],
    ),
    expected,
  );
});

test("interleaveSpec maps an empty set to all, else comma-joins", () => {
  assert.equal(interleaveSpec([]), "all");
  assert.equal(interleaveSpec([0, 2, 3]), "0,2,3");
});

test("buildInterleaveArgs wraps the command in numactl --interleave", () => {
  assert.deepEqual(
    buildInterleaveArgs([], "/bin/llama", ["--model", "/m.gguf"]),
    ["--interleave=all", "--", "/bin/llama", "--model", "/m.gguf"],
  );
  assert.deepEqual(buildInterleaveArgs([0, 1], "/b", []), [
    "--interleave=0,1",
    "--",
    "/b",
  ]);
});
