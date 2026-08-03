import type {
  PrerequisiteCheck,
  PrerequisiteGroup,
  PrerequisiteHost,
  PrerequisiteReport,
} from "@arriero/core";

import { getBuildSettings } from "../build/repository.js";
import { listEnvironmentSpecs } from "../envs/repository.js";
import { listInstances } from "../instances/repository.js";
import {
  installCommandPrefix,
  packageManagerForOsRelease,
  readOsRelease,
} from "../system/os-release.js";
import { autoRepairedPathDirectories } from "../system/path-repair.js";
import { pathEntries } from "../system/tool-probe.js";
import { detectRunMode } from "../update/version.js";
import { instanceArgsNeedHttps } from "./https-usage.js";
import { detectInstallCapability } from "./install-capability.js";
import { buildInstallPlan, summarizeChecks } from "./install-plan.js";
import {
  prerequisiteDefinitions,
  prerequisiteGroups,
  resolveSeverity,
  type PrerequisiteDefinition,
  type PrerequisiteProbeContext,
  type PrerequisiteUsage,
} from "./registry.js";
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

export async function evaluatePrerequisite(
  definition: PrerequisiteDefinition,
  context: PrerequisiteProbeContext,
): Promise<PrerequisiteCheck> {
  const outcome = await definition.probe(context);
  const release = readOsRelease();
  const packageManager = packageManagerForOsRelease(release);
  const packages = definition.packages[packageManager] ?? [];
  const prefix = installCommandPrefix(packageManager);
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
      installCommand:
        prefix && packages.length > 0
          ? `${prefix} ${packages.join(" ")}`
          : null,
      commands:
        typeof definition.commands === "function"
          ? definition.commands(release)
          : definition.commands,
      docPath: definition.docPath,
      note: definition.note,
    },
  };
}

export function prerequisiteProbeContext(): PrerequisiteProbeContext {
  return {
    env: process.env,
    searchDirectories: wellKnownToolDirectories(),
    usage: collectPrerequisiteUsage(),
  };
}

export async function getPrerequisiteReport(): Promise<PrerequisiteReport> {
  const context = prerequisiteProbeContext();
  const [checks, installRunner] = await Promise.all([
    Promise.all(
      prerequisiteDefinitions.map((definition) =>
        evaluatePrerequisite(definition, context),
      ),
    ),
    detectInstallCapability(),
  ]);
  const byId = new Map(
    prerequisiteDefinitions.map((definition, index) => [
      definition.id,
      checks[index]!,
    ]),
  );

  const groups: PrerequisiteGroup[] = prerequisiteGroups.map((group) => ({
    id: group.id,
    title: group.title,
    description: group.description,
    checks: prerequisiteDefinitions
      .filter((definition) => definition.group === group.id)
      .map((definition) => byId.get(definition.id)!),
  }));

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
