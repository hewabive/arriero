import {
  argString,
  sglangModelArg,
  type ConfigDoctorCheck,
  type ConfigDoctorFinding,
  type ConfigDoctorReport,
  type Instance,
} from "@arriero/core";
import { existsSync } from "node:fs";

import { listEnvironments } from "../envs/service.js";
import { hfTokenConfigured } from "../hf/token.js";
import {
  listModelRequirements,
  listModelRequirementStatuses,
} from "../hf/requirements.js";
import { listInstances } from "../instances/repository.js";
import { logger } from "../logger.js";
import {
  DRAFT_MODEL_ARG_KEYS,
  MMPROJ_ARG_KEYS,
} from "../memory-estimate/service.js";
import { listPeerNodes, nodeHasToken } from "../nodes/repository.js";
import { getPathCatalogEntry } from "../path-catalog/repository.js";
import { listPresets, readPreset } from "../presets/repository.js";
import {
  apiEndpointAuthHeaders,
  listApiEndpointCatalog,
} from "../proxy/endpoints.js";
import { getApiProxySettings } from "../proxy/settings.js";
import { getApiProxySourceKey, listApiProxySources } from "../proxy/sources.js";
import { listMemoryPoolsWithStatus } from "../resources/repository.js";
import {
  getKnownGpuInventory,
  type GpuInventory,
} from "../system/resources.js";
import { listWebappRecords } from "../webapps/config-files.js";

function instanceModelPaths(instance: Instance): string[] {
  const values: (string | null | undefined)[] = [];
  if (instance.kind === "llama-server") {
    values.push(argString(instance.args, ["--model", "-m"]));
    for (const key of [...MMPROJ_ARG_KEYS, ...DRAFT_MODEL_ARG_KEYS]) {
      values.push(argString(instance.args, [key]));
    }
  } else if (instance.kind === "vllm") {
    values.push(instance.positionalArgs?.[0]);
  } else if (instance.kind === "sglang") {
    values.push(sglangModelArg(instance));
  }
  if (instance.engineConfig?.type === "ktransformers") {
    values.push(instance.engineConfig.model, instance.engineConfig.cpuWeights);
  }
  return values.filter(
    (value): value is string =>
      typeof value === "string" && value.startsWith("/"),
  );
}

type DoctorFinding = Omit<ConfigDoctorFinding, "checkId">;

function instanceBinaryFindings(instances: Instance[]): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const instance of instances) {
    const configPath = `instances/${instance.name}.json`;
    if (!instance.binaryPath || !existsSync(instance.binaryPath)) {
      findings.push({
        severity: "error",
        summary: `${instance.name}: binary is missing on this host`,
        detail: instance.binaryPath || "no binary path resolves",
        configPath,
        remediation:
          "Build llama.cpp at the expected ref, rebuild the Python environment, or re-pick the binary in the instance form.",
      });
      continue;
    }
    if (
      instance.binaryPathRefId &&
      !getPathCatalogEntry(instance.binaryPathRefId)
    ) {
      findings.push({
        severity: "info",
        summary: `${instance.name}: catalog reference is stale, using the inline path`,
        detail: instance.binaryPath,
        configPath,
        remediation:
          "Expected after cloning a config: the path catalog is machine-local. Re-pick the binary to rebind.",
      });
    }
  }
  return findings;
}

function environmentFindings(): DoctorFinding[] {
  return listEnvironments()
    .filter((environment) => environment.status !== "installed")
    .map((environment) => ({
      severity: "warning" as const,
      summary: `${environment.engine} ${environment.version} is ${environment.status} on this host`,
      detail: environment.error,
      configPath: "envs.json",
      remediation: "Rebuild the environment on the Environments page.",
    }));
}

async function modelRequirementFindings(): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];
  for (const status of await listModelRequirementStatuses()) {
    if (status.state !== "satisfied") {
      findings.push({
        severity: "warning",
        summary: `${status.requirement.repoId} is ${status.state} on this host`,
        detail:
          status.missingPaths.length > 0
            ? `missing: ${status.missingPaths.slice(0, 5).join(", ")}${status.missingPaths.length > 5 ? ", …" : ""}`
            : null,
        configPath: "models.json",
        remediation: "Enqueue the download on the Downloads page.",
      });
    } else if (status.revisionMatch === false) {
      findings.push({
        severity: "info",
        summary: `${status.requirement.repoId}: downloaded revision differs from the required ${status.requirement.revision.slice(0, 8)}`,
        detail: null,
        configPath: "models.json",
        remediation: null,
      });
    }
  }
  return findings;
}

function instanceModelPathFindings(instances: Instance[]): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const instance of instances) {
    for (const path of instanceModelPaths(instance)) {
      if (!existsSync(path)) {
        findings.push({
          severity: "error",
          summary: `${instance.name}: model file is missing on this host`,
          detail: path,
          configPath: `instances/${instance.name}.json`,
          remediation:
            "Download the model (see the model requirements on the Downloads page) or fix the path.",
        });
      }
    }
  }
  return findings;
}

export function doctorResourcePoolFindings(
  inventory: GpuInventory = getKnownGpuInventory(),
  instances: Instance[] = listInstances(),
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const orphaned = listMemoryPoolsWithStatus(inventory).filter(
    (pool) => pool.orphaned,
  );
  if (orphaned.length === 0) {
    return findings;
  }
  const draws = new Map<string, string[]>();
  for (const instance of instances) {
    for (const draw of instance.memory) {
      draws.set(draw.poolId, [
        ...(draws.get(draw.poolId) ?? []),
        instance.name,
      ]);
    }
  }
  for (const pool of orphaned) {
    const holders = draws.get(pool.id) ?? [];
    findings.push({
      severity: holders.length > 0 ? "warning" : "info",
      summary:
        holders.length > 0
          ? `pool ${pool.id} has no device on this host but ${holders.join(", ")} draws on it`
          : `pool ${pool.id} has no device on this host`,
      detail: `deviceRef ${pool.deviceRef ?? "none"} is not detected; the pool contributes zero budget`,
      configPath: "resources.json",
      remediation:
        holders.length > 0
          ? "Move the draws to a present pool or delete the orphaned pool."
          : "Delete the orphaned pool on the Resources page if it is no longer needed.",
    });
  }
  return findings;
}

function proxyCredentialFindings(instances: Instance[]): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const sources = listApiProxySources();
  for (const source of sources) {
    if (!source.keyConfigured) {
      findings.push({
        severity: "warning",
        summary: `request source "${source.name}" has no API key on this host`,
        detail: null,
        configPath: "proxy/sources.json",
        remediation:
          "Keys live in the machine-local .secrets.json; re-enter the key in the source editor.",
      });
    }
  }
  if (
    !getApiProxySettings().allowAnonymous &&
    !sources.some((source) => source.keyConfigured)
  ) {
    findings.push({
      severity: "error",
      summary:
        "anonymous access is off and no request source has a key: every proxy request will get 423",
      detail: null,
      configPath: "proxy/settings.json",
      remediation:
        "Enter at least one source key or enable anonymous access temporarily.",
    });
  }
  for (const endpoint of listApiEndpointCatalog(instances)) {
    if (endpoint.kind !== "external-api") {
      continue;
    }
    const auth = apiEndpointAuthHeaders(endpoint.id);
    if (!auth.ok) {
      findings.push({
        severity: "error",
        summary: auth.error,
        detail: null,
        configPath: "proxy/endpoints.json",
        remediation:
          "Set the environment variable in this host's .env, or store the key in the endpoint editor.",
      });
    } else if (!endpoint.authConfigured) {
      findings.push({
        severity: "info",
        summary: `endpoint "${endpoint.name}" sends no credentials from this host`,
        detail: null,
        configPath: "proxy/endpoints.json",
        remediation:
          "Fine for keyless local endpoints; otherwise store a key or set apiKeyEnvVar.",
      });
    }
  }
  for (const webapp of listWebappRecords()) {
    if (webapp.proxySourceId && !getApiProxySourceKey(webapp.proxySourceId)) {
      findings.push({
        severity: "warning",
        summary: `webapp "${webapp.name}": its proxy source has no key on this host`,
        detail: null,
        configPath: `webapps/${webapp.name}.json`,
        remediation:
          "Re-enter the source key; the webapp falls back to a placeholder key until then.",
      });
    }
  }
  return findings;
}

function nodeTokenFindings(): DoctorFinding[] {
  return listPeerNodes()
    .filter((node) => node.enabled && !nodeHasToken(node.id))
    .map((node) => ({
      severity: "warning" as const,
      summary: `peer node "${node.name}" has no token on this host`,
      detail: null,
      configPath: "nodes.json",
      remediation:
        "Tokens live in the machine-local .secrets.json; re-enter the peer's token on the Nodes page.",
    }));
}

function hfTokenFindings(): DoctorFinding[] {
  if (listModelRequirements().length === 0 || hfTokenConfigured()) {
    return [];
  }
  return [
    {
      severity: "info",
      summary:
        "model requirements exist but no Hugging Face token is stored on this host",
      detail: null,
      configPath: "models.json",
      remediation:
        "Only needed for gated repositories; set the token on the Downloads page if a fetch fails with 401.",
    },
  ];
}

function presetFindings(): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const summary of listPresets()) {
    const document = readPreset(summary.name);
    if (!document) {
      continue;
    }
    for (const entry of document.file.entries) {
      for (const path of [entry.modelPath, entry.mmprojPath]) {
        if (path && path.startsWith("/") && !existsSync(path)) {
          findings.push({
            severity: "warning",
            summary: `preset ${summary.name}: ${entry.name} points at a missing file`,
            detail: path,
            configPath: `presets/${summary.name}.ini`,
            remediation:
              "Preset paths stay absolute (llama-server owns the file); download the model or edit the preset.",
          });
        }
      }
    }
  }
  return findings;
}

type DoctorCheckDefinition = {
  id: string;
  title: string;
  run: (instances: Instance[]) => DoctorFinding[] | Promise<DoctorFinding[]>;
};

const CHECKS: DoctorCheckDefinition[] = [
  {
    id: "instance-binaries",
    title: "Instance binaries",
    run: instanceBinaryFindings,
  },
  {
    id: "environments",
    title: "Python environments",
    run: environmentFindings,
  },
  {
    id: "model-requirements",
    title: "Model requirements",
    run: modelRequirementFindings,
  },
  {
    id: "instance-model-paths",
    title: "Instance model files",
    run: instanceModelPathFindings,
  },
  {
    id: "resource-pools",
    title: "Memory pools",
    run: (instances) =>
      doctorResourcePoolFindings(getKnownGpuInventory(), instances),
  },
  {
    id: "proxy-credentials",
    title: "Proxy credentials",
    run: proxyCredentialFindings,
  },
  { id: "node-tokens", title: "Peer node tokens", run: nodeTokenFindings },
  { id: "hf-token", title: "Hugging Face token", run: hfTokenFindings },
  { id: "presets", title: "Preset model paths", run: presetFindings },
];

export async function getConfigDoctorReport(): Promise<ConfigDoctorReport> {
  const instances = listInstances();
  const checks: ConfigDoctorCheck[] = [];
  for (const definition of CHECKS) {
    try {
      const findings = (await definition.run(instances)).map((finding) => ({
        ...finding,
        checkId: definition.id,
      }));
      checks.push({
        id: definition.id,
        title: definition.title,
        status: findings.length === 0 ? "ok" : "findings",
        findings,
      });
    } catch (error) {
      logger.warn(
        { error, check: definition.id },
        "config doctor check failed",
      );
      checks.push({
        id: definition.id,
        title: definition.title,
        status: "skipped",
        findings: [],
      });
    }
  }
  const all = checks.flatMap((check) => check.findings);
  return {
    checkedAt: new Date().toISOString(),
    checks,
    summary: {
      errors: all.filter((finding) => finding.severity === "error").length,
      warnings: all.filter((finding) => finding.severity === "warning").length,
      infos: all.filter((finding) => finding.severity === "info").length,
    },
  };
}

export async function getConfigDoctorReportOrNull(
  context: Record<string, unknown> = {},
): Promise<ConfigDoctorReport | null> {
  try {
    return await getConfigDoctorReport();
  } catch (error) {
    logger.warn({ ...context, error }, "config doctor report failed");
    return null;
  }
}
