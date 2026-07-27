import type { Instance } from "@arriero/core";
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

test("resolveNumaLaunch passes through when there is no numa config", () => {
  assert.deepEqual(resolveNumaLaunch(instance(), "/bin/llama", ["--a", "1"]), {
    binary: "/bin/llama",
    args: ["--a", "1"],
    cgroupDir: null,
  });
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
