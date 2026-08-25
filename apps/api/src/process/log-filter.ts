import { engineDescriptor, type InstanceKind } from "@arriero/core";
import { networkInterfaces } from "node:os";

const ROUTINE_MANAGER_PROBE_ENDPOINT_SUFFIXES = [
  "/health",
  "/healthcheck",
  "/v1/health",
  "/props",
  "/metrics",
  "/slots",
  "/lora-adapters",
  "/v1/models",
];

const LLAMA_REQUEST_LOG_PATTERN =
  /\bdone request:\s+([A-Z]+)\s+(\S+)\s+(\S+)\s+(\d{3})\b/;

const UVICORN_REQUEST_LOG_PATTERN =
  /^(?:\([^)]*\bpid=\d+\)\s+)?INFO:\s+(\S+) - "([A-Z]+) (\S+) HTTP\/[\d.]+" (\d{3})(?: [A-Za-z][A-Za-z' -]*)?\s*$/;

type ProbeRequestLogLine = {
  method: string;
  path: string;
  remoteAddress: string;
  status: number;
};

let cachedLocalProbeAddresses: Set<string> | null = null;

function normalizeAddress(address: string) {
  const trimmed = address.trim().replace(/^\[|\]$/g, "");
  const withoutZone = trimmed.replace(/%.+$/, "");
  return withoutZone.startsWith("::ffff:")
    ? withoutZone.slice("::ffff:".length)
    : withoutZone;
}

function localProbeAddresses() {
  if (cachedLocalProbeAddresses) {
    return cachedLocalProbeAddresses;
  }

  const addresses = new Set([
    "127.0.0.1",
    "::1",
    "0:0:0:0:0:0:0:1",
    "localhost",
  ]);

  for (const items of Object.values(networkInterfaces())) {
    for (const item of items ?? []) {
      addresses.add(normalizeAddress(item.address));
    }
  }

  cachedLocalProbeAddresses = addresses;
  return addresses;
}

function pathWithoutQuery(path: string) {
  const clean = path.split("?")[0]!.replace(/\/+$/, "");
  return clean || "/";
}

function isRoutineManagerProbePath(path: string) {
  const clean = pathWithoutQuery(path);
  return ROUTINE_MANAGER_PROBE_ENDPOINT_SUFFIXES.some(
    (suffix) => clean === suffix || clean.endsWith(suffix),
  );
}

function isRoutineStatus(status: number) {
  return (status >= 200 && status < 400) || status === 503;
}

function llamaProbeRequestLogLine(line: string): ProbeRequestLogLine | null {
  const match = LLAMA_REQUEST_LOG_PATTERN.exec(line);
  if (!match) {
    return null;
  }
  return {
    method: match[1]!,
    path: match[2]!,
    remoteAddress: match[3]!,
    status: Number(match[4]),
  };
}

function uvicornProbeRequestLogLine(line: string): ProbeRequestLogLine | null {
  const match = UVICORN_REQUEST_LOG_PATTERN.exec(line.trim());
  if (!match) {
    return null;
  }
  return {
    method: match[2]!,
    path: match[3]!,
    remoteAddress: match[1]!.replace(/:\d+$/, ""),
    status: Number(match[4]),
  };
}

function pinoProbeRequestLogLine(line: string): ProbeRequestLogLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const entry = parsed as Record<string, unknown>;
  if (
    entry.message !== "Request completed" ||
    typeof entry.url !== "string" ||
    typeof entry.status_code !== "number"
  ) {
    return null;
  }
  return {
    method: "GET",
    path: entry.url,
    remoteAddress: typeof entry.ip === "string" ? entry.ip : "",
    status: entry.status_code,
  };
}

export type ProbeRequestLogGrammar = "llama" | "uvicorn" | "pino";

export function probeRequestLogGrammar(
  kind: InstanceKind,
): ProbeRequestLogGrammar {
  return engineDescriptor(kind).logs.parser === "llama" ? "llama" : "uvicorn";
}

function probeRequestLogLine(
  line: string,
  grammar: ProbeRequestLogGrammar | undefined,
) {
  if (grammar === "llama") {
    return llamaProbeRequestLogLine(line);
  }
  if (grammar === "uvicorn") {
    return uvicornProbeRequestLogLine(line);
  }
  if (grammar === "pino") {
    return pinoProbeRequestLogLine(line);
  }
  return llamaProbeRequestLogLine(line) ?? uvicornProbeRequestLogLine(line);
}

export function isRoutineManagerProbeRequestLogLine(
  line: string,
  localAddresses = localProbeAddresses(),
  grammar?: ProbeRequestLogGrammar,
) {
  const request = probeRequestLogLine(line, grammar);
  if (!request) {
    return false;
  }

  return (
    (request.method === "GET" || request.method === "HEAD") &&
    isRoutineManagerProbePath(request.path) &&
    Number.isFinite(request.status) &&
    isRoutineStatus(request.status) &&
    localAddresses.has(normalizeAddress(request.remoteAddress))
  );
}

function withoutChildPrefix(line: string) {
  return line.trim().replace(/^\[\d+\]\s+/, "");
}

function withoutLlamaTimestamp(line: string) {
  return withoutChildPrefix(line).replace(/^\d+(?:\.\d+)+\s+/, "");
}

export function isRoutineManagerProbeSideEffectLogLine(line: string) {
  const normalized = withoutLlamaTimestamp(line);
  return (
    /^I\s+srv\s+proxy_reques[t]?:\s+proxying request to model .+ on port \d+\s*$/i.test(
      normalized,
    ) || /^I\s+srv\s+update_slots:\s+all slots are idle\s*$/i.test(normalized)
  );
}

function isRoutineManagerProbeLogLine(
  line: string,
  localAddresses: Set<string>,
  grammar: ProbeRequestLogGrammar | undefined,
) {
  return (
    isRoutineManagerProbeRequestLogLine(line, localAddresses, grammar) ||
    ((grammar === undefined || grammar === "llama") &&
      isRoutineManagerProbeSideEffectLogLine(line))
  );
}

export function filterRoutineProbeLogChunk(
  chunk: string,
  localAddresses = localProbeAddresses(),
  grammar?: ProbeRequestLogGrammar,
) {
  return chunk.split(/(\n)/).reduce((filtered, part, index, parts) => {
    if (index % 2 === 1) {
      return filtered;
    }

    const newline = parts[index + 1] ?? "";
    const line = part.endsWith("\r") ? part.slice(0, -1) : part;
    if (
      newline &&
      isRoutineManagerProbeLogLine(line, localAddresses, grammar)
    ) {
      return filtered;
    }
    return `${filtered}${part}${newline}`;
  }, "");
}
