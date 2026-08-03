import type { PrerequisiteStatus } from "@arriero/core";
import { readFileSync } from "node:fs";

import { findHeader, probePkgConfigModule } from "../system/tool-probe.js";

const minimumOpensslVersion = "3.0.0";

const opensslHeaderPath = "openssl/opensslv.h";

const headerVersionPatterns = [
  /#\s*define\s+OPENSSL_VERSION_STR\s+"([^"]+)"/,
  /#\s*define\s+OPENSSL_VERSION_TEXT\s+"[^"]*?(\d+\.\d+\.\d+)/,
];

export type OpensslProbeResult = {
  status: PrerequisiteStatus;
  detail: string | null;
  version: string | null;
};

function versionTriple(value: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function meetsMinimumVersion(
  value: string,
  minimum: string,
): boolean | null {
  const parsed = versionTriple(value);
  const floor = versionTriple(minimum);
  if (!parsed || !floor) {
    return null;
  }
  for (let index = 0; index < parsed.length; index += 1) {
    if (parsed[index]! !== floor[index]!) {
      return parsed[index]! > floor[index]!;
    }
  }
  return true;
}

export function parseOpensslHeaderVersion(source: string): string | null {
  for (const pattern of headerVersionPatterns) {
    const match = pattern.exec(source);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export function classifyOpensslVersion(
  version: string | null,
  origin: string,
): OpensslProbeResult {
  if (!version) {
    return { status: "unknown", detail: origin, version: null };
  }
  const meets = meetsMinimumVersion(version, minimumOpensslVersion);
  if (meets === null) {
    return { status: "unknown", detail: origin, version };
  }
  if (!meets) {
    return {
      status: "missing",
      detail: `${origin} (OpenSSL ${version} is older than the required ${minimumOpensslVersion})`,
      version,
    };
  }
  return { status: "ok", detail: origin, version };
}

function headerVersion(path: string): string | null {
  try {
    return parseOpensslHeaderVersion(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export async function probeOpensslDevelopmentFiles(
  env: NodeJS.ProcessEnv,
): Promise<OpensslProbeResult> {
  const pkgConfig = await probePkgConfigModule("openssl", env);
  if (pkgConfig.found) {
    return classifyOpensslVersion(pkgConfig.version, "openssl.pc");
  }
  const header = findHeader(opensslHeaderPath);
  if (!header) {
    return { status: "missing", detail: null, version: null };
  }
  return classifyOpensslVersion(headerVersion(header), header);
}
