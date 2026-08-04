import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { applyLegacyEnvFileMigration } from "./env-file-migration.js";
import { managerEnv } from "./manager-env.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultRootDir = resolve(moduleDir, "../../..");

function isTestProcess(): boolean {
  const entrypoint = process.argv[1] ?? "";
  return Boolean(
    process.env.NODE_TEST_WORKER_ID ||
    process.env.NODE_TEST_CONTEXT ||
    /(?:^|[/\\])[^/\\]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entrypoint),
  );
}

const rawTestRoot = process.env.ARRIERO_TEST_ROOT?.trim();
const testIsolationEnabled = isTestProcess() || Boolean(rawTestRoot);
if (testIsolationEnabled && !rawTestRoot) {
  throw new Error(
    "Refusing to load Arriero paths from a test process without ARRIERO_TEST_ROOT; run tests through the package test script",
  );
}

const envFile = resolve(defaultRootDir, ".env");
if (!testIsolationEnabled && existsSync(envFile)) {
  applyLegacyEnvFileMigration(envFile);
  process.loadEnvFile(envFile);
}

function envPath(suffix: string): string | undefined {
  const value = managerEnv(suffix);
  return value ? resolve(value) : undefined;
}

function isWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

function assertTestPathIsolation(paths: Record<string, string>): void {
  if (!testIsolationEnabled) {
    return;
  }
  // The early guard above narrows this in test mode before .env is touched.
  const testRootValue = rawTestRoot!;
  if (!isAbsolute(testRootValue)) {
    throw new Error("ARRIERO_TEST_ROOT must be an absolute path");
  }

  const testRoot = resolve(testRootValue);
  const systemTemp = resolve(tmpdir());
  if (testRoot === systemTemp || !isWithin(systemTemp, testRoot)) {
    throw new Error(
      `ARRIERO_TEST_ROOT must be a dedicated directory below ${systemTemp}`,
    );
  }
  for (const [name, path] of Object.entries(paths)) {
    if (!isWithin(testRoot, path)) {
      throw new Error(
        `${name} must stay inside ARRIERO_TEST_ROOT (${testRoot})`,
      );
    }
  }
}

const rootDir = envPath("HOME") ?? defaultRootDir;
const runtimeDir = envPath("RUNTIME_DIR") ?? resolve(rootDir, "runtime");
const dataDir = envPath("DATA_DIR") ?? resolve(rootDir, "data");
const configDir = envPath("CONFIG_DIR") ?? resolve(dataDir, "config");
const presetsDir = resolve(configDir, "presets");
const instancesDir = resolve(configDir, "instances");
const proxyConfigDir = resolve(configDir, "proxy");
const logsDir = envPath("LOGS_DIR") ?? resolve(runtimeDir, "logs");
const buildsDir = envPath("BUILDS_DIR") ?? resolve(runtimeDir, "builds");
const sourcesDir = envPath("SOURCES_DIR") ?? resolve(runtimeDir, "sources");
const envsDir = envPath("ENVS_DIR") ?? resolve(runtimeDir, "envs");
const pythonDir = envPath("PYTHON_DIR") ?? resolve(runtimeDir, "python");
const uvCacheDir = envPath("UV_CACHE_DIR") ?? resolve(runtimeDir, "uv-cache");
const modelsDir = envPath("MODELS_DIR") ?? resolve(runtimeDir, "models");
const slotsDir = envPath("SLOTS_DIR") ?? resolve(runtimeDir, "slots");

assertTestPathIsolation({
  ARRIERO_DATA_DIR: dataDir,
  ARRIERO_CONFIG_DIR: configDir,
  ARRIERO_RUNTIME_DIR: runtimeDir,
  ARRIERO_LOGS_DIR: logsDir,
  ARRIERO_BUILDS_DIR: buildsDir,
  ARRIERO_SOURCES_DIR: sourcesDir,
  ARRIERO_ENVS_DIR: envsDir,
  ARRIERO_PYTHON_DIR: pythonDir,
  ARRIERO_UV_CACHE_DIR: uvCacheDir,
  ARRIERO_MODELS_DIR: modelsDir,
  ARRIERO_SLOTS_DIR: slotsDir,
});

export const config = {
  host: managerEnv("HOST") ?? "127.0.0.1",
  port: Number(managerEnv("PORT") ?? "8787"),
  rootDir,
  dataDir,
  configDir,
  argumentDefaultsFile: resolve(configDir, "argument-defaults.json"),
  argumentDefaultsSeedFile: resolve(
    defaultRootDir,
    "config/argument-defaults.json",
  ),
  settingsFile: resolve(configDir, "settings.json"),
  settingsSeedFile: resolve(defaultRootDir, "config/settings.json"),
  presetsDir,
  instancesDir,
  proxyConfigDir,
  secretsFile: resolve(configDir, ".secrets.json"),
  configGitignoreFile: resolve(configDir, ".gitignore"),
  runtimeDir,
  logsDir,
  buildsDir,
  sourcesDir,
  envsDir,
  pythonDir,
  uvCacheDir,
  modelsDir,
  slotsDir,
  logs: {
    filterRoutineProbeRequests: managerEnv("FILTER_PROBE_LOGS") !== "false",
  },
  shutdown: {
    stopManagedOnExit: managerEnv("STOP_MANAGED_ON_EXIT") === "true",
    timeoutMs: Number(managerEnv("SHUTDOWN_TIMEOUT_MS") ?? 10_000),
  },
  proxy: {
    idleMaintenanceIntervalMs: Number(
      managerEnv("PROXY_IDLE_INTERVAL_MS") ?? 30_000,
    ),
    resumeClaimWindowMs: Number(
      managerEnv("PROXY_RESUME_CLAIM_WINDOW_MS") ?? 180_000,
    ),
  },
  update: {
    drainTimeoutMs: Number(managerEnv("UPDATE_DRAIN_TIMEOUT_MS") ?? 10_000),
  },
  auth: {
    password: managerEnv("ADMIN_PASSWORD") ?? null,
    passwordHash: managerEnv("ADMIN_PASSWORD_HASH") ?? null,
    secret:
      managerEnv("AUTH_SECRET") ??
      managerEnv("ADMIN_PASSWORD_HASH") ??
      managerEnv("ADMIN_PASSWORD") ??
      null,
    secureCookie: managerEnv("SECURE_COOKIE") === "true",
    sessionTtlSeconds: Number(
      managerEnv("SESSION_TTL_SECONDS") ?? 12 * 60 * 60,
    ),
  },
};

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(config.configDir, { recursive: true });
mkdirSync(config.presetsDir, { recursive: true });
mkdirSync(config.instancesDir, { recursive: true });
mkdirSync(config.proxyConfigDir, { recursive: true });
mkdirSync(config.logsDir, { recursive: true });
mkdirSync(config.sourcesDir, { recursive: true });
mkdirSync(config.envsDir, { recursive: true });
mkdirSync(config.pythonDir, { recursive: true });
mkdirSync(config.uvCacheDir, { recursive: true });
mkdirSync(config.modelsDir, { recursive: true });
