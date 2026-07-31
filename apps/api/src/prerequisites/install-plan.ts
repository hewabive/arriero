import type {
  HostPackageManager,
  PrerequisiteCheck,
  PrerequisiteInstallPlan,
  PrerequisiteInstallStart,
  PrerequisiteReport,
  PrerequisiteSummary,
} from "@arriero/core";

import { installCommandPrefix } from "../system/os-release.js";

const UNCONFIRMED: PrerequisiteCheck["status"][] = ["missing", "unknown"];

function packagesFor(
  checks: PrerequisiteCheck[],
  severities: PrerequisiteCheck["severity"][],
): string[] {
  const packages: string[] = [];
  for (const check of checks) {
    if (
      !UNCONFIRMED.includes(check.status) ||
      !severities.includes(check.severity)
    ) {
      continue;
    }
    for (const name of check.remediation.packages) {
      if (!packages.includes(name)) {
        packages.push(name);
      }
    }
  }
  return packages;
}

export function buildInstallPlan(
  checks: PrerequisiteCheck[],
  packageManager: HostPackageManager,
): PrerequisiteInstallPlan {
  const prefix = installCommandPrefix(packageManager);
  const toCommand = (packages: string[]) =>
    prefix && packages.length > 0 ? `${prefix} ${packages.join(" ")}` : null;

  return {
    packageManager,
    requiredCommand: toCommand(packagesFor(checks, ["required"])),
    allCommand: toCommand(packagesFor(checks, ["required", "recommended"])),
  };
}

export function resolveInstallCommand(
  report: PrerequisiteReport,
  request: PrerequisiteInstallStart,
): string | null {
  if ("checkId" in request) {
    for (const group of report.groups) {
      const check = group.checks.find((item) => item.id === request.checkId);
      if (check) {
        return check.remediation.installCommand;
      }
    }
    return null;
  }
  return request.scope === "required"
    ? report.install.requiredCommand
    : report.install.allCommand;
}

export function summarizeChecks(
  checks: PrerequisiteCheck[],
): PrerequisiteSummary {
  const summary: PrerequisiteSummary = {
    ok: 0,
    missingRequired: 0,
    missingRecommended: 0,
    outOfPath: 0,
    unknown: 0,
  };
  for (const check of checks) {
    if (check.status === "ok") {
      summary.ok += 1;
    } else if (check.status === "out-of-path") {
      summary.outOfPath += 1;
    } else if (check.status === "unknown") {
      summary.unknown += 1;
    } else if (check.severity === "required") {
      summary.missingRequired += 1;
    } else {
      summary.missingRecommended += 1;
    }
  }
  return summary;
}
