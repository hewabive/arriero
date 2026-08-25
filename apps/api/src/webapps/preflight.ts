import {
  isWildcardHost,
  type EnvironmentRecord,
  type WebappConfigRecord,
  type WebappPreflightIssue,
} from "@arriero/core";

import { checkListenAvailable } from "../process/preflight.js";
import { listApiProxyModels } from "../proxy/repository.js";

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

  if (
    record.kind === "chat-ui" &&
    !listApiProxyModels().some((model) => model.visible)
  ) {
    issues.push({
      level: "warning",
      field: "kind",
      message:
        "the API proxy publishes no models — Chat UI reads the model list once at startup, so restart it after a model appears",
    });
  }

  const authEnabled =
    record.settings.type === "open-webui" && record.settings.auth;
  if (isWildcardHost(record.http.host) && !authEnabled) {
    issues.push({
      level: "warning",
      field: "http.host",
      message:
        record.settings.type === "chat-ui"
          ? "the UI listens on all interfaces and Chat UI has no built-in sign-in — anyone on the network gets full access"
          : "the UI listens on all interfaces with authentication disabled — anyone on the network gets full access",
    });
  }

  return issues;
}
