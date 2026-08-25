import { EnvironmentSpecSchema } from "@arriero/core";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  chatUiJobSteps,
  chatUiLauncherSource,
  chatUiLayoutError,
  checkedChatUiSpec,
  patchChatUiManifest,
} from "./chat-ui.js";
import { environmentDirectory, environmentStagingDirectory } from "./paths.js";
import { environmentProvisioner } from "./provisioners.js";

const TOOLS = {
  git: "/usr/bin/git",
  npm: "/usr/bin/npm",
  node: "/usr/bin/node",
};

function chatUiSpec(overrides: Record<string, unknown> = {}) {
  return checkedChatUiSpec(
    EnvironmentSpecSchema.parse({
      engine: "chat-ui",
      version: "v0.10.0",
      id: "chat-ui-provisioner-test",
      ...overrides,
    }),
  );
}

test("chat-ui job plan clones the tag, builds with npm and freezes the commit", () => {
  const spec = chatUiSpec();
  const staging = environmentStagingDirectory(spec);
  const steps = chatUiJobSteps(spec, TOOLS, {
    staging,
    final: environmentDirectory(spec),
  });
  assert.deepEqual(
    steps.map((step) => step.name),
    [
      "source-clone",
      "modules-install",
      "manifest-patch",
      "app-build",
      "modules-prune",
      "freeze",
      "finalize",
      "validate",
    ],
  );
  const clone = steps[0]!.command;
  assert.deepEqual(clone.slice(0, 6), [
    "/usr/bin/git",
    "clone",
    "--depth",
    "1",
    "--branch",
    "v0.10.0",
  ]);
  assert.equal(clone[6], "https://github.com/huggingface/chat-ui");
  assert.equal(clone[7], staging);
  assert.deepEqual(steps[1]!.command, [
    "/usr/bin/npm",
    "--prefix",
    staging,
    "ci",
    "--ignore-scripts",
  ]);
  assert.ok(steps[3]!.command.includes("build"));
  assert.ok(
    steps[3]!.command.some((token) => token.startsWith("NODE_OPTIONS=")),
  );
  assert.deepEqual(steps[5]!.command, [
    "/usr/bin/git",
    "-C",
    staging,
    "rev-parse",
    "HEAD",
  ]);
});

test("chat-ui custom repository URL reaches the clone command", () => {
  const spec = chatUiSpec({
    source: { kind: "git", url: "https://example.com/fork/chat-ui" },
  });
  const clone = chatUiJobSteps(spec, TOOLS, {
    staging: environmentStagingDirectory(spec),
    final: environmentDirectory(spec),
  })[0]!.command;
  assert.ok(clone.includes("https://example.com/fork/chat-ui"));
});

test("chat-ui manifest patch moves mongodb-memory-server to dependencies", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-ui-manifest-"));
  try {
    const manifestPath = resolve(dir, "package.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        dependencies: { mongodb: "^6.0.0" },
        devDependencies: { "mongodb-memory-server": "^10.1.2", vite: "^6.0.0" },
      }),
    );
    const lines: string[] = [];
    const log = {
      write: (chunk: string | Buffer) => lines.push(String(chunk)),
    };
    patchChatUiManifest(dir, log);
    const patched = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.equal(patched.dependencies["mongodb-memory-server"], "^10.1.2");
    assert.equal("mongodb-memory-server" in patched.devDependencies, false);

    patchChatUiManifest(dir, log);
    assert.ok(lines.at(-1)?.includes("already a runtime dependency"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat-ui manifest patch fails loudly when the package is gone", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-ui-manifest-"));
  try {
    writeFileSync(
      resolve(dir, "package.json"),
      JSON.stringify({ dependencies: {}, devDependencies: {} }),
    );
    assert.throws(
      () => patchChatUiManifest(dir, { write: () => {} }),
      /embedded MongoDB patch does not apply/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat-ui launcher maps flags and layers the .env baseline under the rendered env", () => {
  const source = chatUiLauncherSource("/opt/node/bin/node");
  assert.ok(source.startsWith("#!/opt/node/bin/node\n"));

  const dir = mkdtempSync(join(tmpdir(), "chat-ui-launcher-"));
  try {
    mkdirSync(resolve(dir, "bin"));
    mkdirSync(resolve(dir, "build"));
    writeFileSync(resolve(dir, "bin", "chat-ui"), source);
    writeFileSync(
      resolve(dir, "build", "index.js"),
      [
        "const picked = {};",
        "for (const key of ['HOST', 'PORT', 'COOKIE_NAME', 'PUBLIC_APP_DESCRIPTION', 'MONGODB_URL', 'ENABLE_CONFIG_MANAGER']) {",
        "  picked[key] = process.env[key];",
        "}",
        "console.log(JSON.stringify(picked));",
      ].join("\n"),
    );
    writeFileSync(
      resolve(dir, ".env"),
      [
        "COOKIE_NAME=hf-chat",
        'PUBLIC_APP_DESCRIPTION="Community chat."# trailing comment',
        "MONGODB_URL=#your mongodb URL here",
        "ENABLE_CONFIG_MANAGER=true",
        "# a full-line comment",
        "",
      ].join("\n"),
    );
    const result = execFileSync(
      process.execPath,
      [resolve(dir, "bin", "chat-ui"), "--host", "10.0.0.5", "--port", "5555"],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", ENABLE_CONFIG_MANAGER: "false" },
      },
    );
    assert.deepEqual(JSON.parse(result.trim()), {
      HOST: "10.0.0.5",
      PORT: "5555",
      COOKIE_NAME: "hf-chat",
      PUBLIC_APP_DESCRIPTION: "Community chat.",
      MONGODB_URL: "",
      ENABLE_CONFIG_MANAGER: "false",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat-ui layout validation demands entrypoint, bundle and commit freeze", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-ui-layout-"));
  try {
    assert.match(
      chatUiLayoutError(resolve(dir, "absent")) ?? "",
      /directory is missing/,
    );

    const entrypoint = resolve(dir, "bin", "chat-ui");
    mkdirSync(resolve(dir, "bin"), { recursive: true });
    writeFileSync(entrypoint, "#!/usr/bin/node\n");
    chmodSync(entrypoint, 0o755);
    assert.match(chatUiLayoutError(dir) ?? "", /server bundle is missing/);

    mkdirSync(resolve(dir, "build"), { recursive: true });
    writeFileSync(resolve(dir, "build", "index.js"), "");
    assert.match(chatUiLayoutError(dir) ?? "", /freeze file is missing/);

    writeFileSync(resolve(dir, "freeze.txt"), "not-a-hash\n");
    assert.match(chatUiLayoutError(dir) ?? "", /commit hash/);

    writeFileSync(resolve(dir, "freeze.txt"), `${"a".repeat(40)}\n`);
    assert.equal(chatUiLayoutError(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat-ui provisioner is a node-source channel outside the path catalog", () => {
  const provisioner = environmentProvisioner("chat-ui");
  assert.equal(provisioner.tooling, "node-source");
  assert.equal(provisioner.catalogEngineKind, null);
  assert.equal(provisioner.entrypointRelative, "bin/chat-ui");
  assert.deepEqual(provisioner.requirements(chatUiSpec()), []);
  const validate = provisioner.validationCommand(chatUiSpec(), "/final");
  assert.match(validate.at(-1) ?? "", /mongodb-memory-server/);
  assert.deepEqual(
    provisioner.availability(chatUiSpec(), {
      accelerators: [],
      installed: true,
      rocmDeviceAvailable: false,
    }),
    { availability: "usable", availabilityReason: null },
  );
});
