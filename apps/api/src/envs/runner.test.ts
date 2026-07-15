import { EnvironmentCreateSchema, EnvironmentSpecSchema } from "@llama-manager/core";
import assert from "node:assert/strict";
import test from "node:test";

import { environmentJobSteps } from "./runner.js";

function spec(
  source: unknown,
  pythonProvisioning: "download-if-missing" | "require-existing" = "download-if-missing",
) {
  const input = EnvironmentCreateSchema.parse({
    version: "0.24.0",
    pythonVersion: "3.12.13",
    pythonProvisioning,
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

test("pypi environment plan pins Python, version, extras and index", () => {
  const steps = environmentJobSteps(
    spec({
      kind: "pypi",
      extras: ["audio"],
      indexUrl: "https://packages.example/simple",
    }),
    "/usr/bin/uv",
  );
  assert.deepEqual(steps.map((step) => step.name), [
    "python-install",
    "venv-create",
    "package-install",
    "freeze",
    "finalize",
    "validate",
  ]);
  const venv = steps.find((step) => step.name === "venv-create")!;
  assert.ok(venv.command.includes("--relocatable"));
  const install = steps.find((step) => step.name === "package-install")!;
  assert.ok(install.command.includes("vllm[audio]==0.24.0"));
  assert.ok(install.command.includes("https://packages.example/simple"));
  const validate = steps.find((step) => step.name === "validate")!;
  assert.ok(validate.command.at(-1)?.includes("import vllm"));
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
  const command = steps.find((step) => step.name === "package-install")!.command;
  assert.ok(command.includes(`https://example/vllm.whl#sha256=${hash}`));
  assert.ok(command.includes("http://gitea.local/api/packages/pypi/pypi/simple"));
  assert.deepEqual(command.slice(-2), ["--torch-backend", "cpu"]);
});

test("offline environment plan preflights Python without downloads", () => {
  const steps = environmentJobSteps(
    spec(
      { kind: "pypi", extras: [], indexUrl: "http://gitea.local/api/packages/pypi/pypi/simple" },
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
  assert.equal(steps.some((step) => step.name === "python-install"), false);
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
