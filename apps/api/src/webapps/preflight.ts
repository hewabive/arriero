import {
  isWildcardHost,
  type EnvironmentRecord,
  type WebappConfigRecord,
  type WebappPreflightIssue,
} from "@arriero/core";

import { checkListenAvailable } from "../process/preflight.js";

export async function checkWebappStartPreflight(
  record: WebappConfigRecord,
  environment: EnvironmentRecord | null,
  options: { checkPort?: boolean } = {},
): Promise<WebappPreflightIssue[]> {
  const issues: WebappPreflightIssue[] = [];

  if (!environment) {
    issues.push({
      level: "error",
      field: "envSpecId",
      message: "environment spec not found",
    });
  } else if (environment.status !== "installed") {
    issues.push({
      level: "error",
      field: "envSpecId",
      message: `environment is not installed (status: ${environment.status})`,
    });
  } else if (environment.availability !== "usable") {
    issues.push({
      level: "error",
      field: "envSpecId",
      message:
        environment.availabilityReason ?? "environment is not usable here",
    });
  }

  if (options.checkPort ?? true) {
    const bindError = await checkListenAvailable(
      record.http.host,
      record.http.port,
    );
    if (bindError) {
      issues.push({ level: "error", field: "http.port", message: bindError });
    }
  }

  if (isWildcardHost(record.http.host) && !record.settings.auth) {
    issues.push({
      level: "warning",
      field: "http.host",
      message:
        "the UI listens on all interfaces with authentication disabled — anyone on the network gets full access",
    });
  }

  return issues;
}
