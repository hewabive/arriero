import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";

import { config } from "./config.js";
import {
  fromPortableConfig,
  fromPortablePath,
  hasPortablePathCandidate,
  toPortableConfig,
  toPortablePath,
} from "./config-paths.js";

function withRootDir(rootDir: string, run: () => void) {
  const previous = config.rootDir;
  config.rootDir = rootDir;
  try {
    run();
  } finally {
    config.rootDir = previous;
  }
}

test("replaces a managed root prefix with its placeholder", () => {
  const binary = resolve(config.buildsDir, "master/bin/llama-server");
  assert.equal(
    toPortablePath(binary),
    "${ARRIERO_RUNTIME_DIR}/builds/master/bin/llama-server",
  );
});

test("prefers the broadest root that still contains the path", () => {
  withRootDir(dirname(config.runtimeDir), () => {
    const binary = resolve(config.buildsDir, "master/bin/llama-server");
    assert.equal(
      toPortablePath(binary),
      "${ARRIERO_HOME}/runtime/builds/master/bin/llama-server",
    );
  });
});

test("leaves paths outside every managed root untouched", () => {
  assert.equal(toPortablePath("/opt/models/foo.gguf"), "/opt/models/foo.gguf");
  assert.equal(toPortablePath("llama-server"), "llama-server");
  assert.equal(toPortablePath("--ctx-size"), "--ctx-size");
});

test("round-trips a managed path", () => {
  const model = resolve(config.modelsDir, "qwen/model.gguf");
  assert.equal(fromPortablePath(toPortablePath(model)), model);
});

test("expands placeholders embedded in a value", () => {
  assert.equal(
    fromPortablePath("${ARRIERO_MODELS_DIR}/a.gguf:/opt/b.gguf"),
    `${config.modelsDir}/a.gguf:/opt/b.gguf`,
  );
});

test("maps every string leaf of a config tree", () => {
  const record = {
    name: "demo",
    binaryPath: resolve(config.buildsDir, "master/bin/llama-server"),
    args: { "--model": resolve(config.modelsDir, "m.gguf"), "--port": 5190 },
    env: { LD_LIBRARY_PATH: resolve(config.buildsDir, "master/lib") },
    positionalArgs: [resolve(config.runtimeDir, "extra.txt")],
    memory: [],
    numa: null,
  };
  const portable = toPortableConfig(record);
  assert.equal(
    portable.binaryPath,
    "${ARRIERO_RUNTIME_DIR}/builds/master/bin/llama-server",
  );
  assert.equal(
    portable.args["--model"],
    "${ARRIERO_RUNTIME_DIR}/models/m.gguf",
  );
  assert.equal(portable.args["--port"], 5190);
  assert.equal(
    portable.env.LD_LIBRARY_PATH,
    "${ARRIERO_RUNTIME_DIR}/builds/master/lib",
  );
  assert.equal(portable.positionalArgs[0], "${ARRIERO_RUNTIME_DIR}/extra.txt");
  assert.deepEqual(fromPortableConfig(portable), record);
});

test("detects config trees that still carry managed absolute paths", () => {
  assert.equal(
    hasPortablePathCandidate({
      a: [{ b: resolve(config.modelsDir, "m.gguf") }],
    }),
    true,
  );
  assert.equal(
    hasPortablePathCandidate({ a: [{ b: "${ARRIERO_MODELS_DIR}/m.gguf" }] }),
    false,
  );
  assert.equal(
    hasPortablePathCandidate({ a: [{ b: "/opt/m.gguf" }], c: 1, d: null }),
    false,
  );
});
