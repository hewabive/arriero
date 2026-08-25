import type { EnvironmentJobStep, EnvironmentSpec } from "@arriero/core";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import type { CommandLog } from "../jobs/exec.js";
import { executableError } from "../utils/executable.js";
import type { NodeSourceTools } from "./node-tools.js";
import { pendingJobStep } from "./steps.js";

export const CHAT_UI_ENTRYPOINT_RELATIVE = "bin/chat-ui";

const EMBEDDED_MONGO_PACKAGE = "mongodb-memory-server";

export type ChatUiEnvironmentSpec = Extract<
  EnvironmentSpec,
  { engine: "chat-ui" }
>;

export function checkedChatUiSpec(
  spec: EnvironmentSpec,
): ChatUiEnvironmentSpec {
  if (spec.engine !== "chat-ui") {
    throw new Error("Chat UI provisioner kind mismatch");
  }
  return spec;
}

export function chatUiValidationCommand(finalDir: string): string[] {
  const required = [
    resolve(finalDir, "build", "index.js"),
    resolve(finalDir, "build", "handler.js"),
    resolve(finalDir, "node_modules", EMBEDDED_MONGO_PACKAGE, "package.json"),
    resolve(finalDir, "node_modules", "mongodb", "package.json"),
  ];
  const script = [
    "const { existsSync } = require('node:fs');",
    `const required = ${JSON.stringify(required)};`,
    "const missing = required.filter((path) => !existsSync(path));",
    "if (missing.length) { console.error('missing: ' + missing.join(', ')); process.exit(1); }",
    `const manifest = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(resolve(finalDir, "package.json"))}, 'utf8'));`,
    `if (!manifest.dependencies || !manifest.dependencies['${EMBEDDED_MONGO_PACKAGE}']) { console.error('${EMBEDDED_MONGO_PACKAGE} is not a runtime dependency'); process.exit(1); }`,
  ].join("\n");
  return [process.execPath, "-e", script];
}

export function chatUiJobSteps(
  spec: ChatUiEnvironmentSpec,
  tools: NodeSourceTools,
  directories: { staging: string; final: string },
): EnvironmentJobStep[] {
  const { staging, final } = directories;
  return [
    pendingJobStep("source-clone", [
      tools.git,
      "clone",
      "--depth",
      "1",
      "--branch",
      spec.version,
      spec.source.url,
      staging,
    ]),
    pendingJobStep("modules-install", [
      tools.npm,
      "--prefix",
      staging,
      "ci",
      "--ignore-scripts",
    ]),
    pendingJobStep("manifest-patch", ["patch-chat-ui-manifest", staging]),
    pendingJobStep("app-build", [
      "env",
      "NODE_OPTIONS=--max-old-space-size=2048",
      tools.npm,
      "--prefix",
      staging,
      "run",
      "build",
    ]),
    pendingJobStep("modules-prune", [
      tools.npm,
      "--prefix",
      staging,
      "prune",
      "--omit=dev",
      "--ignore-scripts",
    ]),
    pendingJobStep("freeze", [tools.git, "-C", staging, "rev-parse", "HEAD"]),
    pendingJobStep("finalize", ["finalize-environment", staging, final]),
    pendingJobStep("validate", chatUiValidationCommand(final)),
  ];
}

export function patchChatUiManifest(stagingDir: string, log: CommandLog): void {
  const manifestPath = resolve(stagingDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  if (manifest.dependencies?.[EMBEDDED_MONGO_PACKAGE]) {
    log.write(
      `# ${EMBEDDED_MONGO_PACKAGE} is already a runtime dependency; nothing to patch\n`,
    );
    return;
  }
  const pinned = manifest.devDependencies?.[EMBEDDED_MONGO_PACKAGE];
  if (!pinned) {
    throw new Error(
      `${EMBEDDED_MONGO_PACKAGE} is not declared by this chat-ui ref; the embedded MongoDB patch does not apply`,
    );
  }
  delete manifest.devDependencies![EMBEDDED_MONGO_PACKAGE];
  manifest.dependencies = {
    ...manifest.dependencies,
    [EMBEDDED_MONGO_PACKAGE]: pinned,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  log.write(
    `# moved ${EMBEDDED_MONGO_PACKAGE}@${pinned} to dependencies so the server bundle keeps it external\n`,
  );
}

export function chatUiLauncherSource(nodePath: string): string {
  return [
    `#!${nodePath}`,
    'const { readFileSync } = process.getBuiltinModule("node:fs");',
    'const { resolve } = process.getBuiltinModule("node:path");',
    "const argv = process.argv.slice(2);",
    "for (let index = 0; index + 1 < argv.length; index += 2) {",
    '  if (argv[index] === "--host") process.env.HOST = argv[index + 1];',
    '  if (argv[index] === "--port") process.env.PORT = argv[index + 1];',
    "}",
    "try {",
    '  const baseline = resolve(process.argv[1], "..", "..", ".env");',
    '  for (const line of readFileSync(baseline, "utf8").split(/\\r?\\n/)) {',
    "    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);",
    "    if (!match || match[1] in process.env) continue;",
    "    let value = match[2].trim();",
    "    const quote = value[0];",
    "    if (quote === '\"' || quote === \"'\") {",
    "      const end = value.indexOf(quote, 1);",
    "      value = end > 0 ? value.slice(1, end) : value.slice(1);",
    "    } else {",
    '      value = value.replace(/(^|\\s)#.*$/, "").trim();',
    "    }",
    "    process.env[match[1]] = value;",
    "  }",
    "} catch (error) {",
    '  console.error("chat-ui launcher: no .env baseline loaded:", error.message);',
    "}",
    'import("../build/index.js").catch((error) => {',
    "  console.error(error);",
    "  process.exit(1);",
    "});",
    "",
  ].join("\n");
}

export function writeChatUiLauncher(stagingDir: string): void {
  const binDir = resolve(stagingDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const launcher = resolve(binDir, "chat-ui");
  writeFileSync(launcher, chatUiLauncherSource(process.execPath), "utf8");
  chmodSync(launcher, 0o755);
}

export function chatUiLayoutError(finalDir: string): string | null {
  if (!existsSync(finalDir)) {
    return `environment directory is missing: ${finalDir}`;
  }
  const entrypointError = executableError(
    resolve(finalDir, CHAT_UI_ENTRYPOINT_RELATIVE),
    "Chat UI entrypoint",
  );
  if (entrypointError) return entrypointError;

  const server = resolve(finalDir, "build", "index.js");
  if (!existsSync(server)) {
    return `Chat UI server bundle is missing: ${server}`;
  }

  const freeze = resolve(finalDir, "freeze.txt");
  if (!existsSync(freeze)) {
    return `environment freeze file is missing: ${freeze}`;
  }
  const commit = readFileSync(freeze, "utf8").trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    return `environment freeze does not record a commit hash: ${freeze}`;
  }
  return null;
}
