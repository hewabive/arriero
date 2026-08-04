import type {
  PrerequisiteCheck,
  PrerequisiteGroup,
  PrerequisiteHost,
  PrerequisiteReport,
} from "@arriero/core";

import { getBuildSettings } from "../build/repository.js";
import { rocmDeviceAvailable } from "../envs/availability.js";
import { listEnvironmentSpecs } from "../envs/repository.js";
import { listInstances } from "../instances/repository.js";
import {
  detectAmdPciInventory,
  detectNvidiaPciInventory,
} from "../system/pci-inventory.js";
import {
  type NvidiaTelemetryStatus,
  nvidiaTelemetry,
} from "../nvidia/telemetry.js";
import {
  installCommandPrefix,
  packageManagerForOsRelease,
  readOsRelease,
} from "../system/os-release.js";
import {
  augmentProcessPath,
  autoRepairedPathDirectories,
} from "../system/path-repair.js";
import { pathEntries } from "../system/tool-probe.js";
import { detectRunMode } from "../update/version.js";
import { instanceArgsNeedHttps } from "./https-usage.js";
import { detectInstallCapability } from "./install-capability.js";
import {
  buildInstallPlan,
  joinInstallCommands,
  summarizeChecks,
} from "./install-plan.js";
import {
  prerequisiteDefinitions,
  prerequisiteGroups,
  resolveSeverity,
  type PrerequisiteDefinition,
  type PrerequisiteProbeContext,
  type PrerequisiteUsage,
} from "./registry.js";
import {
  PrerequisiteRebootState,
  prerequisiteRebootState,
} from "./reboot-state.js";
import { wellKnownToolDirectories } from "./search-paths.js";

function collectPrerequisiteUsage(): PrerequisiteUsage {
  const instances = listInstances();
  return {
    cudaBuild: getBuildSettings().cuda,
    httpsFeatures: instances.some((instance) =>
      instanceArgsNeedHttps(instance.args),
    ),
    numaBind: instances.some((instance) => instance.numa?.mode === "bind"),
    numaInterleave: instances.some(
      (instance) => instance.numa?.mode === "interleave",
    ),
    pythonEngines: listEnvironmentSpecs().length > 0,
  };
}

function prerequisiteHost(): PrerequisiteHost {
  const release = readOsRelease();
  return {
    platform: process.platform,
    osName: release.prettyName,
    osId: release.id,
    packageManager: packageManagerForOsRelease(release),
    runMode: detectRunMode(process.argv[1]),
    path: pathEntries(process.env.PATH),
    autoRepairedPath: autoRepairedPathDirectories(),
  };
}

function resolveCommands(
  source: PrerequisiteDefinition["commands"] | undefined,
  release: ReturnType<typeof readOsRelease>,
): string[] {
  if (!source) {
    return [];
  }
  return typeof source === "function" ? source(release) : source;
}

export async function evaluatePrerequisite(
  definition: PrerequisiteDefinition,
  context: PrerequisiteProbeContext,
  rebootState: PrerequisiteRebootState = prerequisiteRebootState,
): Promise<PrerequisiteCheck> {
  const outcome = await definition.probe(context);
  if (definition.requiresRebootAfterInstall && outcome.status === "ok") {
    rebootState.clear(definition.id);
  }
  const rebootRequired = Boolean(
    definition.requiresRebootAfterInstall &&
    rebootState.isPending(definition.id),
  );
  const release = readOsRelease();
  const packageManager = packageManagerForOsRelease(release);
  const remediationAvailable = outcome.remediationAvailable !== false;
  const showRemediation = remediationAvailable || rebootRequired;
  const packages = showRemediation
    ? (definition.packages[packageManager] ?? [])
    : [];
  const prefix = installCommandPrefix(packageManager);
  const commands = showRemediation
    ? resolveCommands(definition.commands, release)
    : [];
  const installCommands = showRemediation
    ? resolveCommands(definition.installCommands, release)
    : [];
  const packageInstallCommand =
    prefix && packages.length > 0 ? `${prefix} ${packages.join(" ")}` : null;
  const standaloneInstallCommand = !packageInstallCommand
    ? joinInstallCommands(installCommands)
    : null;
  return {
    id: definition.id,
    title: definition.title,
    kind: definition.kind,
    severity: resolveSeverity(definition, context.usage),
    status: outcome.status,
    blocks: definition.blocks,
    impact: definition.impact,
    detail: outcome.detail,
    version: outcome.version,
    remediation: {
      packages,
      installCommand: packageInstallCommand ?? standaloneInstallCommand,
      commands,
      includeInInstallPlan: definition.includeInInstallPlan !== false,
      rebootRequired,
      docPath: definition.docPath,
      note: definition.note,
    },
  };
}

export function prerequisiteProbeContext(): PrerequisiteProbeContext {
  let telemetryStatus: NvidiaTelemetryStatus | null = null;
  return {
    env: process.env,
    searchDirectories: wellKnownToolDirectories(),
    usage: collectPrerequisiteUsage(),
    nvidiaPci: detectNvidiaPciInventory(),
    amdPci: detectAmdPciInventory(),
    rocmDeviceAvailable: rocmDeviceAvailable(),
    nvidiaTelemetryStatus: () =>
      (telemetryStatus ??= nvidiaTelemetry.status(true)),
  };
}

export function prerequisiteDefinitionIsApplicable(
  definition: PrerequisiteDefinition,
  context: PrerequisiteProbeContext,
  rebootState: PrerequisiteRebootState = prerequisiteRebootState,
): boolean {
  if (
    definition.requiresRebootAfterInstall &&
    rebootState.isPending(definition.id)
  ) {
    return true;
  }
  return definition.applies?.(context) ?? true;
}

export async function getPrerequisiteReport(): Promise<PrerequisiteReport> {
  const context = prerequisiteProbeContext();
  augmentProcessPath(context.searchDirectories);
  const definitions = prerequisiteDefinitions.filter((definition) =>
    prerequisiteDefinitionIsApplicable(definition, context),
  );
  const [checks, installRunner] = await Promise.all([
    Promise.all(
      definitions.map((definition) =>
        evaluatePrerequisite(definition, context),
      ),
    ),
    detectInstallCapability(),
  ]);
  const byId = new Map(
    definitions.map((definition, index) => [definition.id, checks[index]!]),
  );

  const groups: PrerequisiteGroup[] = prerequisiteGroups
    .map((group) => ({
      id: group.id,
      title: group.title,
      description: group.description,
      checks: definitions
        .filter((definition) => definition.group === group.id)
        .map((definition) => byId.get(definition.id)!),
    }))
    .filter((group) => group.checks.length > 0);

  const host = prerequisiteHost();
  return {
    checkedAt: new Date().toISOString(),
    host,
    groups,
    summary: summarizeChecks(checks),
    install: buildInstallPlan(checks, host.packageManager),
    installRunner,
  };
}
