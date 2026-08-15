import { test } from "node:test";
import assert from "node:assert/strict";

import { managerEnv, managerEnvNonEmpty } from "./manager-env.js";

test("prefers the ARRIERO_ name when both are set", () => {
  process.env.ARRIERO_ENV_TEST_BOTH = "current";
  process.env.LLAMA_MANAGER_ENV_TEST_BOTH = "legacy";
  assert.equal(managerEnv("ENV_TEST_BOTH"), "current");
});

test("falls back to the LLAMA_MANAGER_ name", () => {
  process.env.LLAMA_MANAGER_ENV_TEST_LEGACY = "legacy";
  assert.equal(managerEnv("ENV_TEST_LEGACY"), "legacy");
});

test("returns an empty ARRIERO_ value without falling back", () => {
  process.env.ARRIERO_ENV_TEST_EMPTY = "";
  process.env.LLAMA_MANAGER_ENV_TEST_EMPTY = "legacy";
  assert.equal(managerEnv("ENV_TEST_EMPTY"), "");
});

test("returns undefined when neither name is set", () => {
  assert.equal(managerEnv("ENV_TEST_UNSET"), undefined);
});

test("managerEnvNonEmpty treats an empty value as unset", () => {
  process.env.ARRIERO_ENV_TEST_NONEMPTY_EMPTY = "";
  assert.equal(managerEnvNonEmpty("ENV_TEST_NONEMPTY_EMPTY"), undefined);
});

test("managerEnvNonEmpty passes a non-empty value through", () => {
  process.env.ARRIERO_ENV_TEST_NONEMPTY_SET = "value";
  assert.equal(managerEnvNonEmpty("ENV_TEST_NONEMPTY_SET"), "value");
});
