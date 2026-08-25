import type { HfDownloadedRepo } from "@arriero/core";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, test } from "node:test";

import { getModelScanSettings } from "../models/cache-repository.js";
import {
  MODEL_REQUIREMENTS_FILE,
  captureModelRequirement,
  deleteModelRequirement,
  evaluateModelRequirement,
  listModelRequirements,
  removeModelRequirementForDeletedDownload,
  upsertModelRequirement,
} from "./requirements.js";
import { resetAllConfigStores } from "../config-store/registry.js";

beforeEach(() => {
  rmSync(MODEL_REQUIREMENTS_FILE, { force: true });
  resetAllConfigStores();
});

function repoDir(repoId: string): string {
  const [owner, repo] = repoId.split("/");
  return resolve(getModelScanSettings().directory, owner!, repo!);
}

function downloadedRepo(
  repoId: string,
  revision: string,
  files: { path: string; present: boolean }[],
): HfDownloadedRepo {
  return {
    dir: repoDir(repoId),
    repoId,
    revision,
    downloadedAt: "2026-08-25T00:00:00.000Z",
    fileCount: files.length,
    totalBytes: 1,
    missingFiles: files.filter((file) => !file.present).length,
    files: files.map((file) => ({
      path: file.path,
      size: 1,
      oid: "oid",
      lfsOid: null,
      present: file.present,
      partialBytes: 0,
    })),
    orphanParts: [],
    variants: null,
    update: {
      status: "unchecked",
      checkedAt: null,
      revisionSha: null,
      error: null,
      files: [],
    },
  };
}

const SHA = "a".repeat(40);

test("capture upserts by repo and default dest, unioning paths", () => {
  captureModelRequirement({
    repoId: "unsloth/demo",
    revision: SHA,
    destDir: repoDir("unsloth/demo"),
    files: [{ path: "a.gguf" }],
  });
  captureModelRequirement({
    repoId: "unsloth/demo",
    revision: SHA,
    destDir: repoDir("unsloth/demo"),
    files: [{ path: "b.gguf" }, { path: "a.gguf" }],
  });
  const requirements = listModelRequirements();
  assert.equal(requirements.length, 1);
  assert.deepEqual(requirements[0]?.paths, ["a.gguf", "b.gguf"]);
  assert.equal(requirements[0]?.destDir, null);
  assert.equal(
    readFileSync(MODEL_REQUIREMENTS_FILE, "utf8").includes(
      getModelScanSettings().directory,
    ),
    false,
  );
});

test("a non-default destination is stored and keyed separately", () => {
  upsertModelRequirement({
    repoId: "unsloth/demo",
    revision: "main",
    paths: ["a.gguf"],
    destDir: "/mnt/elsewhere/demo",
  });
  upsertModelRequirement({
    repoId: "unsloth/demo",
    revision: "main",
    paths: ["b.gguf"],
    destDir: null,
  });
  const requirements = listModelRequirements();
  assert.equal(requirements.length, 2);
  assert.deepEqual(
    requirements.map((item) => item.destDir).sort(),
    ["/mnt/elsewhere/demo", null].sort(),
  );
});

test("evaluate reports satisfied, partial and missing with revision match", () => {
  const requirement = upsertModelRequirement({
    repoId: "unsloth/demo",
    revision: SHA,
    paths: ["a.gguf", "b.gguf"],
    destDir: null,
  });

  assert.equal(evaluateModelRequirement(requirement, []).state, "missing");

  const partial = evaluateModelRequirement(requirement, [
    downloadedRepo("unsloth/demo", SHA, [
      { path: "a.gguf", present: true },
      { path: "b.gguf", present: false },
    ]),
  ]);
  assert.equal(partial.state, "partial");
  assert.deepEqual(partial.missingPaths, ["b.gguf"]);
  assert.equal(partial.revisionMatch, true);

  const satisfied = evaluateModelRequirement(requirement, [
    downloadedRepo("unsloth/demo", "b".repeat(40), [
      { path: "a.gguf", present: true },
      { path: "b.gguf", present: true },
    ]),
  ]);
  assert.equal(satisfied.state, "satisfied");
  assert.equal(satisfied.revisionMatch, false);

  const floating = upsertModelRequirement({
    repoId: "unsloth/floating",
    revision: "main",
    paths: ["a.gguf"],
    destDir: null,
  });
  const status = evaluateModelRequirement(floating, [
    downloadedRepo("unsloth/floating", SHA, [
      { path: "a.gguf", present: true },
    ]),
  ]);
  assert.equal(status.revisionMatch, null);
});

test("deleting a download removes or trims the matching requirement", () => {
  upsertModelRequirement({
    repoId: "unsloth/demo",
    revision: SHA,
    paths: ["a.gguf", "b.gguf"],
    destDir: null,
  });
  removeModelRequirementForDeletedDownload(repoDir("unsloth/demo"), ["a.gguf"]);
  assert.deepEqual(listModelRequirements()[0]?.paths, ["b.gguf"]);
  removeModelRequirementForDeletedDownload(repoDir("unsloth/demo"), null);
  assert.equal(listModelRequirements().length, 0);
});

test("deleteModelRequirement removes by id", () => {
  const created = upsertModelRequirement({
    repoId: "unsloth/demo",
    revision: "main",
    paths: ["a.gguf"],
    destDir: null,
  });
  assert.equal(deleteModelRequirement(created.id), true);
  assert.equal(deleteModelRequirement(created.id), false);
});
