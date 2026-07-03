import assert from "node:assert/strict";
import test from "node:test";

import { engineArgvBuilder } from "./argv.js";

const flagMap = engineArgvBuilder("flag-map");

test("flag-map argv serializes array values as one comma-separated argument", () => {
  assert.deepEqual(flagMap({ "--device": ["CUDA0", "CUDA1"] }, []), [
    "--device",
    "CUDA0,CUDA1",
  ]);
});

test("flag-map argv skips empty array values", () => {
  assert.deepEqual(flagMap({ "--tags": [] }, []), []);
});

test("flag-map argv emits positional args before sorted flags", () => {
  assert.deepEqual(
    flagMap({ "--port": 8080, "--alpha": true }, ["serve", "model-id"]),
    ["serve", "model-id", "--alpha", "--port", "8080"],
  );
});

test("flag-map argv without positionals matches the legacy flag-only shape", () => {
  assert.deepEqual(
    flagMap({ "--model": "/models/a.gguf", "--flash-attn": true }, []),
    ["--flash-attn", "--model", "/models/a.gguf"],
  );
});
