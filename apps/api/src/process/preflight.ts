import {
  engineDescriptor,
  type EnginePreflightId,
  type Instance,
  type MemoryPool,
  type NumaNode,
  type ProcessPreflightIssue,
  type ProcessPreflightResult,
  type ResourceAdmission,
  type SystemAccelerator,
} from "@arriero/core";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";

import { validateLlamaServerPreflight } from "./preflight-llama.js";
import { validateKTransformersPreflight } from "./preflight-ktransformers.js";
import { validateRpcWorkerReadiness } from "./rpc-preflight.js";

export type PreflightOptions = {
  peers?: Instance[] | undefined;
  accelerators?: SystemAccelerator[] | undefined;
  capacityAdmission?: ResourceAdmission | undefined;
  memoryPools?: MemoryPool[] | undefined;
  numaNodes?: NumaNode[] | undefined;
  cpuFlags?: string[] | undefined;
  physicalCoreCount?: number | undefined;
  hostAvailableMemoryBytes?: number | undefined;
  swapTotalBytes?: number | undefined;
  runtimeProbeTimeoutMs?: number | undefined;
};

type EnginePreflightCheck = (
  instance: Instance,
  issues: ProcessPreflightIssue[],
  options: PreflightOptions,
) => void;

const ENGINE_PREFLIGHT_CHECKS: Record<
  EnginePreflightId,
  EnginePreflightCheck | null
> = {
  "llama-server": validateLlamaServerPreflight,
  ktransformers: validateKTransformersPreflight,
  none: null,
};

type StartPreflightOptions = PreflightOptions & {
  checkPortAvailability?: boolean | undefined;
  allowActiveSelfPort?: boolean | undefined;
};

function nowIso() {
  return new Date().toISOString();
}

export class ProcessPreflightError extends Error {
  constructor(readonly result: ProcessPreflightResult) {
    super(
      result.issues
        .filter((issue) => issue.level === "error")
        .map((issue) => issue.message)
        .join("; "),
    );
    this.name = "ProcessPreflightError";
  }
}

function validateBinary(instance: Instance, issues: ProcessPreflightIssue[]) {
  if (!instance.binaryPath) {
    issues.push({
      level: "error",
      field: "binaryPathRefId",
      message: instance.binaryPathRefId
        ? "Binary catalog entry is missing; select a binary from the catalog."
        : "No binary is selected.",
    });
    return;
  }

  if (!existsSync(instance.binaryPath)) {
    issues.push({
      level: "error",
      field: "binaryPath",
      message: `Binary not found: ${instance.binaryPath}`,
    });
    return;
  }

  const stat = statSync(instance.binaryPath);
  if (!stat.isFile()) {
    issues.push({
      level: "error",
      field: "binaryPath",
      message: `Binary path is not a file: ${instance.binaryPath}`,
    });
    return;
  }

  if (process.platform !== "win32") {
    try {
      accessSync(instance.binaryPath, constants.X_OK);
    } catch {
      issues.push({
        level: "error",
        field: "binaryPath",
        message: `Binary is not executable: ${instance.binaryPath}`,
      });
    }
  }
}

function validateWorkingDirectory(
  instance: Instance,
  issues: ProcessPreflightIssue[],
) {
  const cwd = instance.cwd ?? dirname(instance.binaryPath);
  if (!existsSync(cwd)) {
    issues.push({
      level: "error",
      field: "cwd",
      message: `Working directory not found: ${cwd}`,
    });
    return;
  }
  if (!statSync(cwd).isDirectory()) {
    issues.push({
      level: "error",
      field: "cwd",
      message: `Working directory is not a directory: ${cwd}`,
    });
  }
}

function configuredPortArg(
  instance: Instance,
): { key: string; value: Instance["args"][string] } | null {
  for (const key of engineDescriptor(instance.kind).http.portArgKeys) {
    const value = instance.args[key];
    if (value !== undefined && value !== null) {
      return { key, value };
    }
  }
  return null;
}

function validatePort(instance: Instance, issues: ProcessPreflightIssue[]) {
  const configured = configuredPortArg(instance);
  if (!configured) {
    return;
  }
  const port = Number(configured.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    issues.push({
      level: "error",
      field: `args.${configured.key}`,
      message: `Invalid port: ${String(configured.value)}`,
    });
  }
}

function bindErrorMessage(host: string, port: number, error: Error) {
  const code = (error as Error & { code?: string }).code;
  if (code === "EADDRINUSE") {
    return `Port ${port} is already in use on ${host}`;
  }
  if (code === "EADDRNOTAVAIL") {
    return `Host ${host} is not available on this machine`;
  }
  if (code === "EACCES" || code === "EPERM") {
    return `Port ${port} cannot be bound without additional permissions on ${host}`;
  }
  return `Unable to bind ${host}:${port}: ${error.message}`;
}

function checkListenAvailable(host: string, port: number) {
  return new Promise<string | null>((resolve) => {
    const server = createServer();
    let settled = false;
    const timeout = setTimeout(() => {
      finish(`Timed out while checking ${host}:${port}`);
    }, 1_000);

    function finish(message: string | null) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      server.removeAllListeners();
      if (server.listening) {
        server.close(() => resolve(message));
        return;
      }
      resolve(message);
    }

    server.unref();
    server.once("error", (error) => {
      finish(bindErrorMessage(host, port, error));
    });
    server.listen({ host, port }, () => {
      finish(null);
    });
  });
}

function argString(instance: Instance, key: string, fallback: string) {
  const value = instance.args[key];
  if (value === undefined || value === null || Array.isArray(value)) {
    return fallback;
  }
  return String(value);
}

function normalizedHost(instance: Instance) {
  const host = argString(instance, "--host", "127.0.0.1").trim() || "127.0.0.1";
  if (host === "localhost") {
    return "127.0.0.1";
  }
  return host;
}

function parsedPort(instance: Instance) {
  const configured = configuredPortArg(instance);
  const port = Number(
    configured?.value ?? engineDescriptor(instance.kind).http.defaultPort,
  );
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function hostsOverlap(left: string, right: string) {
  return (
    left === right ||
    left === "0.0.0.0" ||
    right === "0.0.0.0" ||
    left === "::" ||
    right === "::"
  );
}

const activePortStatuses = new Set<Instance["status"]>([
  "starting",
  "running",
  "stopping",
  "stale",
]);

function isActivePortOwner(instance: Instance) {
  return activePortStatuses.has(instance.status);
}

function validatePortConflicts(
  instance: Instance,
  issues: ProcessPreflightIssue[],
  peers: Instance[],
) {
  const port = parsedPort(instance);
  if (!port) {
    return;
  }

  const host = normalizedHost(instance);
  for (const peer of peers) {
    if (peer.name === instance.name) {
      continue;
    }
    const peerPort = parsedPort(peer);
    if (peerPort !== port || !hostsOverlap(host, normalizedHost(peer))) {
      continue;
    }

    issues.push({
      level: isActivePortOwner(peer) ? "error" : "warning",
      field: "args.--port",
      message: `Port ${port} conflicts with ${peer.name} (${peer.status})`,
    });
  }
}

function hasActiveSelfPort(instance: Instance, peers: Instance[]) {
  const port = parsedPort(instance);
  if (!port) {
    return false;
  }

  const host = normalizedHost(instance);
  return peers.some(
    (peer) =>
      peer.name === instance.name &&
      isActivePortOwner(peer) &&
      parsedPort(peer) === port &&
      hostsOverlap(host, normalizedHost(peer)),
  );
}

async function validatePortAvailability(
  instance: Instance,
  issues: ProcessPreflightIssue[],
  options: StartPreflightOptions,
) {
  const port = parsedPort(instance);
  if (!port) {
    return;
  }

  if (
    options.allowActiveSelfPort &&
    hasActiveSelfPort(instance, options.peers ?? [])
  ) {
    return;
  }

  const host = normalizedHost(instance);
  const message = await checkListenAvailable(host, port);
  if (message) {
    issues.push({
      level: "error",
      field: "args.--port",
      message,
    });
  }
}

function validateMemoryCapacity(
  instance: Instance,
  issues: ProcessPreflightIssue[],
  options: PreflightOptions,
) {
  const admission = options.capacityAdmission;
  if (!admission || admission.ok) {
    return;
  }
  for (const shortfall of admission.shortfalls) {
    const deficitGib = (shortfall.deficitBytes / 1024 ** 3).toFixed(1);
    const freeGib = (shortfall.availableBytes / 1024 ** 3).toFixed(1);
    issues.push({
      level: instance.kind === "ktransformers" ? "error" : "warning",
      field: "memory",
      message:
        instance.kind === "ktransformers"
          ? `Memory pool ${shortfall.poolId} is over budget: needs ${deficitGib} GiB more than the ${freeGib} GiB free. KTransformers strict admission cannot be overridden.`
          : `Memory pool ${shortfall.poolId} is over budget: needs ${deficitGib} GiB more than the ${freeGib} GiB free. Starting will require confirmation.`,
    });
  }
}

export function validateInstancePreflight(
  instance: Instance,
  options: PreflightOptions = {},
): ProcessPreflightResult {
  const issues: ProcessPreflightIssue[] = [];

  try {
    validateBinary(instance, issues);
  } catch (error) {
    issues.push({
      level: "error",
      field: "binaryPath",
      message: (error as Error).message,
    });
  }

  try {
    validateWorkingDirectory(instance, issues);
  } catch (error) {
    issues.push({
      level: "error",
      field: "cwd",
      message: (error as Error).message,
    });
  }

  validatePort(instance, issues);
  validatePortConflicts(instance, issues, options.peers ?? []);
  const engineChecks =
    ENGINE_PREFLIGHT_CHECKS[
      engineDescriptor(instance.kind).preflight.engineChecks
    ];
  if (engineChecks) {
    engineChecks(instance, issues, options);
  }
  validateMemoryCapacity(instance, issues, options);

  return {
    instanceId: instance.name,
    ok: !issues.some((issue) => issue.level === "error"),
    issues,
    checkedAt: nowIso(),
  };
}

export async function validateInstanceStartPreflight(
  instance: Instance,
  options: StartPreflightOptions = {},
): Promise<ProcessPreflightResult> {
  const result = validateInstancePreflight(instance, options);
  if (options.checkPortAvailability === false) {
    return result;
  }

  await validatePortAvailability(instance, result.issues, options);
  result.issues.push(
    ...(await validateRpcWorkerReadiness(instance, options.peers ?? [])),
  );
  return {
    ...result,
    ok: !result.issues.some((issue) => issue.level === "error"),
    checkedAt: nowIso(),
  };
}
