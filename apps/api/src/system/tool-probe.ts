import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ToolProbe = {
  found: string | null;
  inPath: boolean;
  version: string | null;
};

export function executableName(name: string) {
  if (process.platform === "win32" && !/\.(?:bat|cmd|exe)$/i.test(name)) {
    return `${name}.exe`;
  }
  return name;
}

export function pathEntries(pathValue: string | undefined): string[] {
  return (pathValue ?? "").split(delimiter).filter(Boolean);
}

export function findExecutableInPath(
  name: string,
  pathValue: string | undefined,
): string | null {
  for (const directory of pathEntries(pathValue)) {
    const candidate = resolve(directory, executableName(name));
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveExecutable(
  value: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (isAbsolute(value)) {
    return existsSync(value) ? value : null;
  }
  if (value.includes("/") || value.includes("\\")) {
    const candidate = resolve(value);
    return existsSync(candidate) ? candidate : null;
  }
  return findExecutableInPath(value, env.PATH);
}

function firstLine(output: string): string | null {
  const line = output.split("\n").find((item) => item.trim().length > 0);
  return line?.trim() ?? null;
}

async function readVersion(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: 5_000,
      env,
    });
    return firstLine(stdout) ?? firstLine(stderr);
  } catch {
    return null;
  }
}

export async function probeExecutable(
  name: string,
  options: {
    env?: NodeJS.ProcessEnv;
    extraDirectories?: string[];
    versionArgs?: string[] | null;
  } = {},
): Promise<ToolProbe> {
  const env = options.env ?? process.env;
  const inPath = findExecutableInPath(name, env.PATH);
  if (inPath) {
    const version =
      options.versionArgs === null
        ? null
        : await readVersion(inPath, options.versionArgs ?? ["--version"], env);
    return { found: inPath, inPath: true, version };
  }

  const outside = findExecutableInPath(
    name,
    (options.extraDirectories ?? []).join(delimiter),
  );
  if (!outside) {
    return { found: null, inPath: false, version: null };
  }
  const version =
    options.versionArgs === null
      ? null
      : await readVersion(outside, options.versionArgs ?? ["--version"], env);
  return { found: outside, inPath: false, version };
}

export async function probeAnyExecutable(
  names: string[],
  options: Parameters<typeof probeExecutable>[1] = {},
): Promise<ToolProbe & { name: string | null }> {
  for (const name of names) {
    const probe = await probeExecutable(name, options);
    if (probe.found) {
      return { ...probe, name };
    }
  }
  return { found: null, inPath: false, version: null, name: null };
}

const includeRoots = [
  "/usr/include",
  `/usr/include/${process.arch === "arm64" ? "aarch64" : "x86_64"}-linux-gnu`,
  "/usr/local/include",
];

export function findHeader(
  relativePath: string,
  roots: string[] = includeRoots,
): string | null {
  for (const root of roots) {
    const candidate = resolve(root, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function probePkgConfigModule(
  module: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ToolProbe> {
  const pkgConfig = findExecutableInPath("pkg-config", env.PATH);
  if (!pkgConfig) {
    return { found: null, inPath: false, version: null };
  }
  try {
    const { stdout } = await execFileAsync(
      pkgConfig,
      ["--modversion", module],
      { encoding: "utf8", timeout: 5_000, env },
    );
    const version = firstLine(stdout);
    return version
      ? { found: module, inPath: true, version }
      : { found: null, inPath: false, version: null };
  } catch {
    return { found: null, inPath: false, version: null };
  }
}
