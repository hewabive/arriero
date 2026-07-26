import type { BuildJobStep, PrerequisiteCheck } from "@llama-manager/core";

import { buildInstallPlan } from "../prerequisites/install-plan.js";
import {
  findPrerequisiteDefinition,
  type PrerequisiteProbeContext,
} from "../prerequisites/registry.js";
import {
  evaluatePrerequisite,
  prerequisiteProbeContext,
} from "../prerequisites/report.js";
import {
  packageManagerForOsRelease,
  readOsRelease,
} from "../system/os-release.js";

const INTERNAL_COMMANDS = new Set(["clean-build-dir"]);

const COMMAND_PREREQUISITES: Record<string, string[]> = {
  git: ["git"],
  npm: ["node", "npm"],
  cmake: ["cmake"],
};

const CONFIGURE_PREREQUISITES = [
  "cxx-toolchain",
  "make",
  "pkg-config",
  "libcurl-dev",
];

export function buildPrerequisiteIds(
  steps: BuildJobStep[],
  options: { cuda: boolean },
): string[] {
  const ids: string[] = [];
  const add = (id: string) => {
    if (!ids.includes(id)) {
      ids.push(id);
    }
  };

  for (const step of steps) {
    for (const token of step.command) {
      if (INTERNAL_COMMANDS.has(token)) {
        continue;
      }
      for (const id of COMMAND_PREREQUISITES[token] ?? []) {
        add(id);
      }
    }
    if (step.name === "configure") {
      for (const id of CONFIGURE_PREREQUISITES) {
        add(id);
      }
      if (options.cuda) {
        add("nvcc");
      }
    }
  }

  return ids;
}

export function formatBuildPrerequisiteError(
  blocking: PrerequisiteCheck[],
  installCommand: string | null,
): string {
  const details = blocking
    .map((check) => {
      const packages = check.remediation.packages.join(" ");
      return packages ? `${check.title} (${packages})` : check.title;
    })
    .join(", ");
  const hint = installCommand
    ? ` Install with: ${installCommand}`
    : " Open the Prerequisites page for per-distribution install commands.";
  return `missing build prerequisites: ${details}.${hint}`;
}

export async function checkBuildPrerequisites(
  ids: string[],
  context: PrerequisiteProbeContext,
): Promise<PrerequisiteCheck[]> {
  const definitions = ids
    .map((id) => findPrerequisiteDefinition(id))
    .filter((definition) => definition !== null);
  const checks = await Promise.all(
    definitions.map((definition) => evaluatePrerequisite(definition, context)),
  );
  return checks.filter((check) => check.status === "missing");
}

export async function assertBuildPrerequisites(
  steps: BuildJobStep[],
  options: { cuda: boolean },
): Promise<void> {
  const blocking = await checkBuildPrerequisites(
    buildPrerequisiteIds(steps, options),
    prerequisiteProbeContext(),
  );
  if (blocking.length === 0) {
    return;
  }

  const plan = buildInstallPlan(
    blocking,
    packageManagerForOsRelease(readOsRelease()),
  );
  throw new Error(formatBuildPrerequisiteError(blocking, plan.allCommand));
}
