import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultRootDir = resolve(moduleDir, "../../..");

const envFile = resolve(defaultRootDir, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const rootDir = resolve(process.env.LLAMA_MANAGER_HOME ?? defaultRootDir);
const runtimeDir = process.env.LLAMA_MANAGER_RUNTIME_DIR
  ? resolve(process.env.LLAMA_MANAGER_RUNTIME_DIR)
  : resolve(rootDir, "runtime");
const dataDir = process.env.LLAMA_MANAGER_DATA_DIR
  ? resolve(process.env.LLAMA_MANAGER_DATA_DIR)
  : resolve(rootDir, "data");
const configDir = process.env.LLAMA_MANAGER_CONFIG_DIR
  ? resolve(process.env.LLAMA_MANAGER_CONFIG_DIR)
  : resolve(dataDir, "config");

export const config = {
  host: process.env.LLAMA_MANAGER_HOST ?? "127.0.0.1",
  port: Number(process.env.LLAMA_MANAGER_PORT ?? "8787"),
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
  presetsDir: resolve(configDir, "presets"),
  instancesDir: resolve(configDir, "instances"),
  proxyConfigDir: resolve(configDir, "proxy"),
  secretsFile: resolve(configDir, ".secrets.json"),
  configGitignoreFile: resolve(configDir, ".gitignore"),
  runtimeDir,
  logsDir: process.env.LLAMA_MANAGER_LOGS_DIR
    ? resolve(process.env.LLAMA_MANAGER_LOGS_DIR)
    : resolve(runtimeDir, "logs"),
  buildsDir: process.env.LLAMA_MANAGER_BUILDS_DIR
    ? resolve(process.env.LLAMA_MANAGER_BUILDS_DIR)
    : resolve(runtimeDir, "builds"),
  modelsDir: process.env.LLAMA_MANAGER_MODELS_DIR
    ? resolve(process.env.LLAMA_MANAGER_MODELS_DIR)
    : resolve(runtimeDir, "models"),
  slotsDir: process.env.LLAMA_MANAGER_SLOTS_DIR
    ? resolve(process.env.LLAMA_MANAGER_SLOTS_DIR)
    : resolve(runtimeDir, "slots"),
  logs: {
    filterRoutineProbeRequests:
      process.env.LLAMA_MANAGER_FILTER_PROBE_LOGS !== "false",
  },
  shutdown: {
    stopManagedOnExit:
      process.env.LLAMA_MANAGER_STOP_MANAGED_ON_EXIT === "true",
    timeoutMs: Number(process.env.LLAMA_MANAGER_SHUTDOWN_TIMEOUT_MS ?? 10_000),
  },
  proxy: {
    idleMaintenanceIntervalMs: Number(
      process.env.LLAMA_MANAGER_PROXY_IDLE_INTERVAL_MS ?? 30_000,
    ),
    resumeClaimWindowMs: Number(
      process.env.LLAMA_MANAGER_PROXY_RESUME_CLAIM_WINDOW_MS ?? 180_000,
    ),
  },
  update: {
    drainTimeoutMs: Number(
      process.env.LLAMA_MANAGER_UPDATE_DRAIN_TIMEOUT_MS ?? 10_000,
    ),
  },
  auth: {
    password: process.env.LLAMA_MANAGER_ADMIN_PASSWORD ?? null,
    passwordHash: process.env.LLAMA_MANAGER_ADMIN_PASSWORD_HASH ?? null,
    secret:
      process.env.LLAMA_MANAGER_AUTH_SECRET ??
      process.env.LLAMA_MANAGER_ADMIN_PASSWORD_HASH ??
      process.env.LLAMA_MANAGER_ADMIN_PASSWORD ??
      null,
    secureCookie: process.env.LLAMA_MANAGER_SECURE_COOKIE === "true",
    sessionTtlSeconds: Number(
      process.env.LLAMA_MANAGER_SESSION_TTL_SECONDS ?? 12 * 60 * 60,
    ),
  },
};

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(config.configDir, { recursive: true });
mkdirSync(config.presetsDir, { recursive: true });
mkdirSync(config.instancesDir, { recursive: true });
mkdirSync(config.proxyConfigDir, { recursive: true });
mkdirSync(config.logsDir, { recursive: true });
mkdirSync(config.modelsDir, { recursive: true });
