import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { managerEnv } from "./manager-env.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultRootDir = resolve(moduleDir, "../../..");

const envFile = resolve(defaultRootDir, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

function envPath(suffix: string): string | undefined {
  const value = managerEnv(suffix);
  return value ? resolve(value) : undefined;
}

const rootDir = envPath("HOME") ?? defaultRootDir;
const runtimeDir = envPath("RUNTIME_DIR") ?? resolve(rootDir, "runtime");
const dataDir = envPath("DATA_DIR") ?? resolve(rootDir, "data");
const configDir = envPath("CONFIG_DIR") ?? resolve(dataDir, "config");

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
  presetsDir: resolve(configDir, "presets"),
  instancesDir: resolve(configDir, "instances"),
  proxyConfigDir: resolve(configDir, "proxy"),
  secretsFile: resolve(configDir, ".secrets.json"),
  configGitignoreFile: resolve(configDir, ".gitignore"),
  runtimeDir,
  logsDir: envPath("LOGS_DIR") ?? resolve(runtimeDir, "logs"),
  buildsDir: envPath("BUILDS_DIR") ?? resolve(runtimeDir, "builds"),
  sourcesDir: envPath("SOURCES_DIR") ?? resolve(runtimeDir, "sources"),
  envsDir: envPath("ENVS_DIR") ?? resolve(runtimeDir, "envs"),
  modelsDir: envPath("MODELS_DIR") ?? resolve(runtimeDir, "models"),
  slotsDir: envPath("SLOTS_DIR") ?? resolve(runtimeDir, "slots"),
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
    sessionTtlSeconds: Number(managerEnv("SESSION_TTL_SECONDS") ?? 12 * 60 * 60),
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
mkdirSync(config.modelsDir, { recursive: true });
