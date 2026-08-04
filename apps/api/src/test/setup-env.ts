import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const testHome = join(tmpdir(), `arriero-api-test-${randomUUID()}`);
const testRuntime = join(testHome, "runtime");

process.env.ARRIERO_TEST_ROOT = testHome;
process.env.ARRIERO_DATA_DIR = join(testHome, "data");
process.env.ARRIERO_CONFIG_DIR = join(testHome, "data", "config");
process.env.ARRIERO_RUNTIME_DIR = testRuntime;
process.env.ARRIERO_LOGS_DIR = join(testRuntime, "logs");
process.env.ARRIERO_BUILDS_DIR = join(testRuntime, "builds");
process.env.ARRIERO_SOURCES_DIR = join(testRuntime, "sources");
process.env.ARRIERO_ENVS_DIR = join(testRuntime, "envs");
process.env.ARRIERO_PYTHON_DIR = join(testRuntime, "python");
process.env.ARRIERO_UV_CACHE_DIR = join(testRuntime, "uv-cache");
process.env.ARRIERO_MODELS_DIR = join(testRuntime, "models");
process.env.ARRIERO_SLOTS_DIR = join(testRuntime, "slots");
process.env.ARRIERO_STOP_MANAGED_ON_EXIT = "false";

mkdirSync(testHome, { recursive: true });

const { migrate } = await import("../db/index.js");
migrate();

process.on("exit", () => {
  rmSync(testHome, { recursive: true, force: true });
});
