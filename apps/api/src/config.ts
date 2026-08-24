import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import { applyLegacyEnvFileMigration } from "./env-file-migration.js";
import { managerEnv, managerEnvNonEmpty } from "./manager-env.js";
import { isPathWithin } from "./path-utils.js";

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

function resolveTestRoot(): string | null {
  const raw = process.env.ARRIERO_TEST_ROOT?.trim();
  if (!raw) {
    if (isTestProcess()) {
      throw new Error(
        "Refusing to load Arriero paths from a test process without ARRIERO_TEST_ROOT; run tests through the package test script",
      );
    }
    return null;
  }
  if (!isAbsolute(raw)) {
    throw new Error("ARRIERO_TEST_ROOT must be an absolute path");
  }
  const root = resolve(raw);
  const systemTemp = resolve(tmpdir());
  if (root === systemTemp || !isPathWithin(systemTemp, root)) {
    throw new Error(
      `ARRIERO_TEST_ROOT must be a dedicated directory below ${systemTemp}`,
    );
  }
  return root;
}

const testRoot = resolveTestRoot();

const envFile = resolve(defaultRootDir, ".env");
if (testRoot === null && existsSync(envFile)) {
  applyLegacyEnvFileMigration(envFile);
  process.loadEnvFile(envFile);
}

function envPath(suffix: string): string | undefined {
  const value = managerEnv(suffix);
  return value ? resolve(value) : undefined;
}

const isolatedPaths: Record<string, string> = {};

function managedPath(suffix: string, fallback: string): string {
  const path = envPath(suffix) ?? fallback;
  isolatedPaths[`ARRIERO_${suffix}`] = path;
  return path;
}

const rootDir = envPath("HOME") ?? defaultRootDir;
const runtimeDir = managedPath("RUNTIME_DIR", resolve(rootDir, "runtime"));
const dataDir = managedPath("DATA_DIR", resolve(rootDir, "data"));
const configDir = managedPath("CONFIG_DIR", resolve(dataDir, "config"));
const presetsDir = resolve(configDir, "presets");
const instancesDir = resolve(configDir, "instances");
const proxyConfigDir = resolve(configDir, "proxy");
const logsDir = managedPath("LOGS_DIR", resolve(runtimeDir, "logs"));
const buildsDir = managedPath("BUILDS_DIR", resolve(runtimeDir, "builds"));
const sourcesDir = managedPath("SOURCES_DIR", resolve(runtimeDir, "sources"));
const envsDir = managedPath("ENVS_DIR", resolve(runtimeDir, "envs"));
const pythonDir = managedPath("PYTHON_DIR", resolve(runtimeDir, "python"));
const uvCacheDir = managedPath("UV_CACHE_DIR", resolve(runtimeDir, "uv-cache"));
const vllmCacheDir = managedPath(
  "VLLM_CACHE_DIR",
  resolve(runtimeDir, "cache/vllm"),
);
const modelsDir = managedPath("MODELS_DIR", resolve(runtimeDir, "models"));
const slotsDir = managedPath("SLOTS_DIR", resolve(runtimeDir, "slots"));
const webappsDir = managedPath("WEBAPPS_DIR", resolve(runtimeDir, "webapps"));

if (testRoot !== null) {
  for (const [name, path] of Object.entries(isolatedPaths)) {
    if (!isPathWithin(testRoot, path)) {
      throw new Error(
        `${name} must stay inside ARRIERO_TEST_ROOT (${testRoot})`,
      );
    }
  }
}

export const config = {
  host: managerEnvNonEmpty("HOST") ?? "127.0.0.1",
  port: Number(managerEnvNonEmpty("PORT") ?? "8787"),
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
  vllmCacheDir,
  modelsDir,
  slotsDir,
  webappsDir,
  webappsConfigDir: resolve(configDir, "webapps"),
  logs: {
    filterRoutineProbeRequests: managerEnv("FILTER_PROBE_LOGS") !== "false",
  },
  shutdown: {
    stopManagedOnExit: managerEnv("STOP_MANAGED_ON_EXIT") === "true",
    timeoutMs: Number(managerEnvNonEmpty("SHUTDOWN_TIMEOUT_MS") ?? 10_000),
  },
  proxy: {
    idleMaintenanceIntervalMs: Number(
      managerEnvNonEmpty("PROXY_IDLE_INTERVAL_MS") ?? 30_000,
    ),
    resumeClaimWindowMs: Number(
      managerEnvNonEmpty("PROXY_RESUME_CLAIM_WINDOW_MS") ?? 180_000,
    ),
  },
  memoryAssessment: {
    autoIntervalMs: Number(
      managerEnvNonEmpty("MEMORY_ASSESS_INTERVAL_MS") ?? 60_000,
    ),
  },
  update: {
    drainTimeoutMs: Number(
      managerEnvNonEmpty("UPDATE_DRAIN_TIMEOUT_MS") ?? 10_000,
    ),
  },
  auth: {
    password: managerEnvNonEmpty("ADMIN_PASSWORD") ?? null,
    passwordHash: managerEnvNonEmpty("ADMIN_PASSWORD_HASH") ?? null,
    secret:
      managerEnvNonEmpty("AUTH_SECRET") ??
      managerEnvNonEmpty("ADMIN_PASSWORD_HASH") ??
      managerEnvNonEmpty("ADMIN_PASSWORD") ??
      null,
    secureCookie: managerEnv("SECURE_COOKIE") === "true",
    sessionTtlSeconds: Number(
      managerEnvNonEmpty("SESSION_TTL_SECONDS") ?? 12 * 60 * 60,
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
mkdirSync(config.vllmCacheDir, { recursive: true });
mkdirSync(config.modelsDir, { recursive: true });
mkdirSync(config.webappsDir, { recursive: true });
mkdirSync(config.webappsConfigDir, { recursive: true });
mkdirSync(resolve(config.logsDir, "webapps"), { recursive: true });
