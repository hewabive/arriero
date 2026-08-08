import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const testHome = join(tmpdir(), `arriero-api-test-${randomUUID()}`);

process.env.ARRIERO_TEST_ROOT = testHome;
process.env.ARRIERO_DATA_DIR = join(testHome, "data");
process.env.ARRIERO_CONFIG_DIR = join(testHome, "data", "config");
process.env.ARRIERO_RUNTIME_DIR = join(testHome, "runtime");
process.env.ARRIERO_STOP_MANAGED_ON_EXIT = "false";
process.env.LOG_LEVEL ??= "silent";

mkdirSync(testHome, { recursive: true });

const { migrate } = await import("../db/index.js");
migrate();

process.on("exit", () => {
  rmSync(testHome, { recursive: true, force: true });
});
