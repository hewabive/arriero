import type {
  EnvironmentRecord,
  WebappConfigRecord,
  WebappPreflightIssue,
} from "@arriero/core";
import { createConnection } from "node:net";

const PORT_PROBE_TIMEOUT_MS = 400;

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

export function webappProbeHost(host: string): string {
  return WILDCARD_HOSTS.has(host) ? "127.0.0.1" : host;
}

function portInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolveDone) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolveDone(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => finish(false));
  });
}

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

  if (
    (options.checkPort ?? true) &&
    (await portInUse(webappProbeHost(record.http.host), record.http.port))
  ) {
    issues.push({
      level: "error",
      field: "http.port",
      message: `port ${record.http.port} is already accepting connections`,
    });
  }

  if (WILDCARD_HOSTS.has(record.http.host) && !record.settings.auth) {
    issues.push({
      level: "warning",
      field: "http.host",
      message:
        "the UI listens on all interfaces with authentication disabled — anyone on the network gets full access",
    });
  }

  return issues;
}
