import { strict as assert } from "node:assert";
import test from "node:test";

import { hfDeleteBlockers } from "./in-use.js";

const dir = "/models/owner/repo";

test("whole-repo delete is blocked by a process referencing a file inside the dir", () => {
  const blockers = hfDeleteBlockers({ dir, paths: null }, [
    {
      instanceId: "qwen",
      cliArgs: ["--model", `${dir}/q4/model-Q4_K_M.gguf`],
    },
    { instanceId: "other", cliArgs: ["--model", "/models/elsewhere/m.gguf"] },
  ]);
  assert.deepEqual(blockers, ["qwen"]);
});

test("whole-repo delete is blocked by a combined key=value token", () => {
  const blockers = hfDeleteBlockers({ dir, paths: null }, [
    { instanceId: "vllm", cliArgs: [`--model=${dir}`] },
  ]);
  assert.deepEqual(blockers, ["vllm"]);
});

test("per-file delete blocks only processes referencing the targeted files", () => {
  const processes = [
    { instanceId: "uses-q4", cliArgs: ["--model", `${dir}/model-Q4.gguf`] },
    { instanceId: "uses-q8", cliArgs: ["--model", `${dir}/model-Q8.gguf`] },
  ];
  assert.deepEqual(
    hfDeleteBlockers({ dir, paths: ["model-Q4.gguf"] }, processes),
    ["uses-q4"],
  );
  assert.deepEqual(
    hfDeleteBlockers({ dir, paths: ["other.gguf"] }, processes),
    [],
  );
});

test("per-file delete is blocked when the whole dir is referenced as a model path", () => {
  const blockers = hfDeleteBlockers(
    { dir, paths: ["model-00002-of-00003.safetensors"] },
    [{ instanceId: "vllm", cliArgs: ["--model", dir] }],
  );
  assert.deepEqual(blockers, ["vllm"]);
});

test("deleting one split shard blocks a process referencing the first shard", () => {
  const blockers = hfDeleteBlockers(
    { dir, paths: ["model-00002-of-00003.gguf"] },
    [
      {
        instanceId: "llama",
        cliArgs: ["--model", `${dir}/model-00001-of-00003.gguf`],
      },
    ],
  );
  assert.deepEqual(blockers, ["llama"]);
});

test("blocker names are unique and sorted", () => {
  const blockers = hfDeleteBlockers({ dir, paths: null }, [
    { instanceId: "b", cliArgs: [`${dir}/x.gguf`, `${dir}/y.gguf`] },
    { instanceId: "a", cliArgs: [`${dir}/x.gguf`] },
  ]);
  assert.deepEqual(blockers, ["a", "b"]);
});
