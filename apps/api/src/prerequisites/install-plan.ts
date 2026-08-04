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

export const INSTALL_COMMAND_SEPARATOR = " && ";

export function joinInstallCommands(commands: string[]): string | null {
  return commands.length > 0 ? commands.join(INSTALL_COMMAND_SEPARATOR) : null;
}

function unconfirmedChecks(
  checks: PrerequisiteCheck[],
  severities: PrerequisiteCheck["severity"][],
): PrerequisiteCheck[] {
  return checks.filter(
    (check) =>
      UNCONFIRMED.includes(check.status) && severities.includes(check.severity),
  );
}

function packagesFor(checks: PrerequisiteCheck[]): string[] {
  const packages: string[] = [];
  for (const check of checks) {
    for (const name of check.remediation.packages) {
      if (!packages.includes(name)) {
        packages.push(name);
      }
    }
  }
  return packages;
}

function standaloneCommandsFor(checks: PrerequisiteCheck[]): string[] {
  return checks.flatMap((check) =>
    check.remediation.packages.length === 0 && check.remediation.installCommand
      ? [check.remediation.installCommand]
      : [],
  );
}

export function buildInstallPlan(
  checks: PrerequisiteCheck[],
  packageManager: HostPackageManager,
): PrerequisiteInstallPlan {
  const prefix = installCommandPrefix(packageManager);
  const toCommand = (severities: PrerequisiteCheck["severity"][]) => {
    const relevant = unconfirmedChecks(checks, severities).filter(
      (check) => check.remediation.includeInInstallPlan,
    );
    const packages = packagesFor(relevant);
    const commands = standaloneCommandsFor(relevant);
    if (prefix && packages.length > 0) {
      commands.unshift(`${prefix} ${packages.join(" ")}`);
    }
    return joinInstallCommands(commands);
  };

  return {
    packageManager,
    requiredCommand: toCommand(["required"]),
    allCommand: toCommand(["required", "recommended"]),
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
        return check.remediation.rebootRequired
          ? null
          : check.remediation.installCommand;
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
