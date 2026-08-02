import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { config } from "../config.js";
import { saveArgumentDefaults } from "./defaults-repository.js";

test("argument defaults are stored sorted by key", () => {
  saveArgumentDefaults({
    instance: [
      { key: "--port", value: "8080", valueType: "number" },
      { key: "--alias", value: "m", valueType: "string" },
      { key: "--ctx-size", value: "4096", valueType: "number" },
    ],
    updatedAt: null,
  });

  const raw = JSON.parse(readFileSync(config.argumentDefaultsFile, "utf8")) as {
    instance: Array<{ key: string }>;
  };
  assert.deepEqual(
    raw.instance.map((item) => item.key),
    ["--alias", "--ctx-size", "--port"],
  );
});
