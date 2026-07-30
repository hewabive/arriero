import type { EnvironmentSpec } from "@arriero/core";
import { EnvironmentCreateSchema, EnvironmentSpecSchema } from "@arriero/core";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { getEnvironmentJob } from "./repository.js";
import { environmentDirectory, environmentStagingDirectory } from "./paths.js";
import { environmentJobSteps, environmentRunner } from "./runner.js";

function spec(
  source: unknown,
  pythonProvisioning:
    | "download-if-missing"
    | "mirror"
    | "require-existing" = "download-if-missing",
  pythonMirrorUrl: string | null = null,
) {
  const input = EnvironmentCreateSchema.parse({
    version: "0.24.0",
    pythonVersion: "3.12.13",
    pythonProvisioning,
    pythonMirrorUrl,
    source,
  });
  return EnvironmentSpecSchema.parse({
    ...input,
    id: "env-test-1234",
    pathCatalogEntryId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function ktransformersSpec(source: unknown) {
  const input = EnvironmentCreateSchema.parse({
    engine: "ktransformers",
    version: "0.6.3.post1",
    pythonVersion: "3.12",
    source,
  });
  return EnvironmentSpecSchema.parse({
    ...input,
    id: "env-kt-test-1234",
    pathCatalogEntryId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function installCommand(environment: EnvironmentSpec) {
  return environmentJobSteps(environment, "uv").find(
    (step) => step.name === "package-install",
  )!.command;
}

function indexFlags(command: string[]) {
  const flags: string[] = [];
  command.forEach((token, position) => {
    if (token !== "--default-index" && token !== "--index") return;
    flags.push(token, command[position + 1]!);
  });
  return flags;
}

test("pypi environment plan pins Python, version, extras and index", () => {
  const steps = environmentJobSteps(
    spec({
      kind: "pypi",
      extras: ["audio"],
      indexUrl: "https://packages.example/simple",
    }),
    "/usr/bin/uv",
  );
  assert.deepEqual(
    steps.map((step) => step.name),
    [
      "python-install",
      "venv-create",
      "package-install",
      "freeze",
      "finalize",
      "validate",
    ],
  );
  const venv = steps.find((step) => step.name === "venv-create")!;
  assert.ok(venv.command.includes("--relocatable"));
  const install = steps.find((step) => step.name === "package-install")!;
  assert.ok(install.command.includes("vllm[audio]==0.24.0"));
  assert.ok(install.command.includes("https://packages.example/simple"));
  const freeze = steps.find((step) => step.name === "freeze")!;
  assert.deepEqual(freeze.command.slice(1, 5), [
    "pip",
    "list",
    "--format",
    "freeze",
  ]);
  const validate = steps.find((step) => step.name === "validate")!;
  assert.ok(validate.command.at(-1)?.includes("import vllm"));
});

test("pypi environment plan without a dependency index resolves everything from one index", () => {
  const command = installCommand(
    spec({
      kind: "pypi",
      extras: [],
      indexUrl: "https://gitea.local/api/packages/team/pypi/simple",
    }),
  );
  assert.deepEqual(indexFlags(command), [
    "--default-index",
    "https://gitea.local/api/packages/team/pypi/simple",
  ]);
});

test("pypi environment plan maps the dependency index to the default index and the root index to a priority index", () => {
  const command = installCommand(
    spec({
      kind: "pypi",
      extras: [],
      indexUrl: "https://gitea.local/api/packages/team/pypi/simple",
      dependencyIndexUrl: "https://pypi.org/simple",
    }),
  );
  assert.deepEqual(indexFlags(command), [
    "--default-index",
    "https://pypi.org/simple",
    "--index",
    "https://gitea.local/api/packages/team/pypi/simple",
  ]);
});

test("KTransformers pypi plan carries the dependency index for both roots", () => {
  const command = installCommand(
    ktransformersSpec({
      kind: "pypi",
      indexUrl: "https://gitea.local/api/packages/team/pypi/simple",
      dependencyIndexUrl: "https://packages.local/simple",
    }),
  );
  assert.deepEqual(indexFlags(command), [
    "--default-index",
    "https://packages.local/simple",
    "--index",
    "https://gitea.local/api/packages/team/pypi/simple",
  ]);
  assert.ok(command.includes("kt-kernel==0.6.3.post1"));
  assert.ok(command.includes("sglang-kt==0.6.3.post1"));
});

test("wheel environment plan carries hash and torch backend", () => {
  const hash = "a".repeat(64);
  const steps = environmentJobSteps(
    spec({
      kind: "wheel",
      url: "https://example/vllm.whl",
      sha256: hash,
      dependencyIndexUrl: "http://gitea.local/api/packages/pypi/pypi/simple",
      torchBackend: "cpu",
    }),
    "uv",
  );
  const command = steps.find(
    (step) => step.name === "package-install",
  )!.command;
  assert.ok(command.includes(`https://example/vllm.whl#sha256=${hash}`));
  assert.ok(
    command.includes("http://gitea.local/api/packages/pypi/pypi/simple"),
  );
  assert.deepEqual(command.slice(-2), ["--torch-backend", "cpu"]);
});

test("offline environment plan preflights Python without downloads", () => {
  const steps = environmentJobSteps(
    spec(
      {
        kind: "pypi",
        extras: [],
        indexUrl: "http://gitea.local/api/packages/pypi/pypi/simple",
      },
      "require-existing",
    ),
    "uv",
  );

  assert.equal(steps[0]?.name, "python-preflight");
  assert.deepEqual(steps[0]?.command, [
    "uv",
    "python",
    "find",
    "--no-project",
    "--managed-python",
    "--no-python-downloads",
    "--show-version",
    "3.12.13",
  ]);
  assert.equal(
    steps.some((step) => step.name === "python-install"),
    false,
  );
});

test("runtime mirror environment plan confines Python download to the bundle mirror", () => {
  const mirror = "file:///media/airgap/python-runtime-mirror";
  const steps = environmentJobSteps(
    spec({ kind: "pypi", extras: [], indexUrl: null }, "mirror", mirror),
    "uv",
  );

  assert.deepEqual(steps[0]?.command, [
    "uv",
    "python",
    "install",
    "--mirror",
    mirror,
    "3.12.13",
  ]);
});

test("environment source rejects credential-bearing URLs", () => {
  assert.equal(
    EnvironmentCreateSchema.safeParse({
      version: "1.0.0",
      source: {
        kind: "pypi",
        extras: [],
        indexUrl: "https://user:secret@example.com/simple",
      },
    }).success,
    false,
  );
});

test("KTransformers PyPI plan installs both matched roots in one transaction", () => {
  const steps = environmentJobSteps(
    ktransformersSpec({
      kind: "pypi",
      indexUrl: "https://packages.example/simple",
    }),
    "/usr/bin/uv",
  );
  const installs = steps.filter((step) => step.name === "package-install");
  assert.equal(installs.length, 1);
  assert.ok(installs[0]?.command.includes("kt-kernel==0.6.3.post1"));
  assert.ok(installs[0]?.command.includes("sglang-kt==0.6.3.post1"));
  assert.ok(installs[0]?.command.includes("https://packages.example/simple"));
  const validate = steps.find((step) => step.name === "validate")!;
  assert.ok(validate.command.at(-1)?.includes("import kt_kernel"));
  assert.ok(validate.command.at(-1)?.includes("import sglang"));
  assert.ok(validate.command.at(-1)?.includes("kt_kernel_ext.CPUInfer(1)"));
  assert.ok(validate.command[0]?.endsWith("/bin/python"));
});

test("KTransformers wheel plan orders both roots and carries hashes", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const steps = environmentJobSteps(
    ktransformersSpec({
      kind: "wheels",
      artifacts: [
        {
          distribution: "sglang-kt",
          url: "https://packages.example/sglang_kt.whl",
          sha256: b,
        },
        {
          distribution: "kt-kernel",
          url: "file:///bundle/kt_kernel.whl",
          sha256: a,
        },
      ],
      dependencyIndexUrl: "https://packages.example/simple",
      torchBackend: "cu128",
    }),
    "uv",
  );
  const command = steps.find(
    (step) => step.name === "package-install",
  )!.command;
  const ktIndex = command.indexOf(`file:///bundle/kt_kernel.whl#sha256=${a}`);
  const verify = steps.find((step) => step.name === "artifact-verify");
  const localKtIndex = command.indexOf("/bundle/kt_kernel.whl");
  const sglangIndex = command.indexOf(
    `https://packages.example/sglang_kt.whl#sha256=${b}`,
  );
  assert.ok(verify);
  assert.equal(ktIndex, -1);
  assert.ok(localKtIndex > 0);
  assert.ok(sglangIndex > localKtIndex);
  assert.deepEqual(command.slice(-2), ["--torch-backend", "cu128"]);
});

test("local wheel hash mismatch fails before package installation", async () => {
  const fakeBin = mkdtempSync(join(tmpdir(), "arriero-hash-uv-"));
  const artifacts = mkdtempSync(join(tmpdir(), "arriero-wheel-artifacts-"));
  const uv = join(fakeBin, "uv");
  const ktWheel = join(artifacts, "kt_kernel-0.6.3.post1-py3-none-any.whl");
  const sglangWheel = join(
    artifacts,
    "sglang_kt-0.6.3.post1-py3-none-any.whl",
  );
  writeFileSync(ktWheel, "not the expected wheel");
  writeFileSync(sglangWheel, "also not the expected wheel");
  writeFileSync(
    uv,
    [
      "#!/bin/sh",
      'if [ "$1" = "python" ]; then exit 0; fi',
      'if [ "$1" = "venv" ]; then',
      "  for last; do :; done",
      '  mkdir -p "$last/bin"',
      "  exit 0",
      "fi",
      "exit 99",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const environment = EnvironmentSpecSchema.parse({
    ...ktransformersSpec({
      kind: "wheels",
      artifacts: [
        {
          distribution: "kt-kernel",
          url: pathToFileURL(ktWheel).href,
          sha256: "a".repeat(64),
        },
        {
          distribution: "sglang-kt",
          url: pathToFileURL(sglangWheel).href,
          sha256: "b".repeat(64),
        },
      ],
      dependencyIndexUrl: null,
      torchBackend: null,
    }),
    id: "env-kt-hash-test-1234",
  });
  rmSync(environmentDirectory(environment), { recursive: true, force: true });
  rmSync(environmentStagingDirectory(environment), {
    recursive: true,
    force: true,
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ""}`;
  try {
    const started = environmentRunner.start(environment);
    let job = getEnvironmentJob(started.id);
    for (
      let attempt = 0;
      attempt < 200 && job?.status === "running";
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      job = getEnvironmentJob(started.id);
    }
    assert.equal(job?.status, "failed");
    assert.match(job?.error ?? "", /wheel SHA-256 mismatch/);
    assert.equal(
      job?.steps.find((step) => step.name === "artifact-verify")?.status,
      "failed",
    );
    assert.equal(
      job?.steps.find((step) => step.name === "package-install")?.status,
      "pending",
    );
    assert.equal(existsSync(environmentDirectory(environment)), false);
    assert.equal(existsSync(environmentStagingDirectory(environment)), false);
  } finally {
    process.env.PATH = previousPath;
    rmSync(fakeBin, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  }
});

test("KTransformers source requires one wheel for each root distribution", () => {
  const invalid = EnvironmentCreateSchema.safeParse({
    engine: "ktransformers",
    version: "0.6.3.post1",
    source: {
      kind: "wheels",
      artifacts: [
        {
          distribution: "kt-kernel",
          url: "file:///bundle/a.whl",
        },
        {
          distribution: "kt-kernel",
          url: "file:///bundle/b.whl",
        },
      ],
      dependencyIndexUrl: null,
      torchBackend: null,
    },
  });
  assert.equal(invalid.success, false);
});

test("KTransformers schema narrows Python and accelerator variants", () => {
  assert.equal(
    EnvironmentCreateSchema.safeParse({
      engine: "ktransformers",
      version: "0.6.3.post1",
      pythonVersion: "3.10",
    }).success,
    false,
  );
  assert.equal(
    EnvironmentCreateSchema.safeParse({
      engine: "ktransformers",
      version: "0.6.3.post1",
      variant: "rocm",
    }).success,
    false,
  );
});

test("failed matched-root install removes KTransformers staging transaction", async () => {
  const fakeBin = mkdtempSync(join(tmpdir(), "arriero-fake-uv-"));
  const uv = join(fakeBin, "uv");
  writeFileSync(
    uv,
    [
      "#!/bin/sh",
      'if [ "$1" = "python" ]; then exit 0; fi',
      'if [ "$1" = "venv" ]; then',
      "  for last; do :; done",
      '  mkdir -p "$last/bin"',
      '  printf "#!/bin/sh\\nexit 0\\n" > "$last/bin/python"',
      '  chmod +x "$last/bin/python"',
      "  exit 0",
      "fi",
      'if [ "$1" = "pip" ] && [ "$2" = "install" ]; then exit 7; fi',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const environment = ktransformersSpec({ kind: "pypi", indexUrl: null });
  rmSync(environmentDirectory(environment), { recursive: true, force: true });
  rmSync(environmentStagingDirectory(environment), {
    recursive: true,
    force: true,
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ""}`;
  try {
    const started = environmentRunner.start(environment);
    let job = getEnvironmentJob(started.id);
    for (
      let attempt = 0;
      attempt < 200 && job?.status === "running";
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      job = getEnvironmentJob(started.id);
    }
    assert.equal(job?.status, "failed");
    assert.equal(
      job?.steps.find((step) => step.name === "package-install")?.exitCode,
      7,
    );
    assert.equal(existsSync(environmentDirectory(environment)), false);
    assert.equal(existsSync(environmentStagingDirectory(environment)), false);
  } finally {
    process.env.PATH = previousPath;
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("canceling KTransformers install removes staging and publishes nothing", async () => {
  const fakeBin = mkdtempSync(join(tmpdir(), "arriero-slow-uv-"));
  const uv = join(fakeBin, "uv");
  writeFileSync(
    uv,
    [
      "#!/bin/sh",
      'if [ "$1" = "python" ]; then exit 0; fi',
      'if [ "$1" = "venv" ]; then',
      "  for last; do :; done",
      '  mkdir -p "$last/bin"',
      '  printf "#!/bin/sh\\nexit 0\\n" > "$last/bin/python"',
      '  chmod +x "$last/bin/python"',
      "  exit 0",
      "fi",
      'if [ "$1" = "pip" ] && [ "$2" = "install" ]; then sleep 30; fi',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const environment = EnvironmentSpecSchema.parse({
    ...ktransformersSpec({ kind: "pypi", indexUrl: null }),
    id: "env-kt-cancel-1234",
  });
  rmSync(environmentDirectory(environment), { recursive: true, force: true });
  rmSync(environmentStagingDirectory(environment), {
    recursive: true,
    force: true,
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ""}`;
  try {
    const started = environmentRunner.start(environment);
    let job = getEnvironmentJob(started.id);
    for (
      let attempt = 0;
      attempt < 200 && job?.currentStep !== "package-install";
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      job = getEnvironmentJob(started.id);
    }
    assert.equal(job?.currentStep, "package-install");
    environmentRunner.cancel(started.id);
    await environmentRunner.shutdown();
    job = getEnvironmentJob(started.id);
    assert.equal(job?.status, "canceled");
    assert.equal(existsSync(environmentDirectory(environment)), false);
    assert.equal(existsSync(environmentStagingDirectory(environment)), false);
  } finally {
    process.env.PATH = previousPath;
    rmSync(fakeBin, { recursive: true, force: true });
  }
});
