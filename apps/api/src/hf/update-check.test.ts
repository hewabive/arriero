import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import { writeHfManifest, type HfManifest } from "./manifest.js";
import {
  diffHfManifest,
  getHfUpdateCheck,
  pruneHfUpdateCheckFiles,
  resetHfUpdateChecksForTests,
  runHfUpdateChecks,
} from "./update-check.js";

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

function manifest(
  files: HfManifest["files"],
  repoId = "owner/repo",
): HfManifest {
  return {
    version: 1,
    repoId,
    revision: OLD_SHA,
    downloadedAt: "2026-08-17T00:00:00.000Z",
    files,
  };
}

function manifestFile(
  path: string,
  input?: { oid?: string; lfsOid?: string | null },
): HfManifest["files"][number] {
  return {
    path,
    size: 10,
    oid: input?.oid ?? "oid-1",
    lfsOid: input?.lfsOid ?? null,
    lastCommitId: null,
    lastCommitDate: null,
  };
}

beforeEach(() => {
  resetHfUpdateChecksForTests();
});

test("diff compares lfs oids when both sides have them", () => {
  const diff = diffHfManifest(
    manifest([
      manifestFile("same.bin", { lfsOid: "sha-same" }),
      manifestFile("changed.bin", { lfsOid: "sha-old" }),
      manifestFile("plain.txt", { oid: "git-1" }),
      manifestFile("gone.bin"),
    ]),
    new Map([
      ["same.bin", { oid: "x", lfs: { oid: "sha-same" } }],
      ["changed.bin", { oid: "x", lfs: { oid: "sha-new" } }],
      ["plain.txt", { oid: "git-2", lfs: null }],
    ]),
  );
  assert.equal(diff.status, "drift");
  assert.deepEqual(
    diff.files.map((file) => [file.path, file.status]),
    [
      ["same.bin", "current"],
      ["changed.bin", "updated"],
      ["plain.txt", "updated"],
      ["gone.bin", "deleted"],
    ],
  );
});

test("diff reports in-sync when every file matches", () => {
  const diff = diffHfManifest(
    manifest([manifestFile("a.txt", { oid: "git-1" })]),
    new Map([["a.txt", { oid: "git-1", lfs: null }]]),
  );
  assert.equal(diff.status, "in-sync");
});

function tempManifestDir(files: HfManifest["files"], repoId?: string): string {
  const dir = join(config.runtimeDir, `hf-check-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  writeHfManifest(dir, manifest(files, repoId));
  return dir;
}

test("checks short-circuit to in-sync when the head sha is unchanged", async () => {
  const dir = tempManifestDir([manifestFile("a.bin")]);
  let requests = 0;
  const fetchImpl = (async () => {
    requests += 1;
    return new Response(JSON.stringify({ sha: OLD_SHA }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const result = await runHfUpdateChecks([dir], { fetchImpl, token: null });
  const check = result[dir];
  assert.equal(check?.status, "in-sync");
  assert.equal(check?.revisionSha, OLD_SHA);
  assert.equal(requests, 1);
  assert.equal(getHfUpdateCheck(dir).status, "in-sync");
  rmSync(dir, { recursive: true, force: true });
});

test("a failing repo reports error while others complete", async () => {
  const driftDir = tempManifestDir([manifestFile("a.bin", { oid: "git-old" })]);
  const errorDir = tempManifestDir([manifestFile("b.bin")], "owner/broken");
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("owner/broken")) {
      throw new Error("network down");
    }
    if (url.includes("/paths-info/")) {
      return new Response(
        JSON.stringify([
          { type: "file", path: "a.bin", oid: "git-new", size: 10 },
        ]),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ sha: NEW_SHA }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const result = await runHfUpdateChecks([driftDir, errorDir], {
    fetchImpl,
    token: null,
  });
  assert.equal(result[driftDir]?.status, "drift");
  assert.deepEqual(result[driftDir]?.files, [
    { path: "a.bin", status: "updated" },
  ]);
  assert.equal(result[errorDir]?.status, "error");
  assert.match(result[errorDir]?.error ?? "", /network down/);
  rmSync(driftDir, { recursive: true, force: true });
  rmSync(errorDir, { recursive: true, force: true });
});

test("prune drops removed paths from a cached check and recomputes status", async () => {
  const dir = tempManifestDir([
    manifestFile("a.bin", { oid: "git-old" }),
    manifestFile("b.bin", { oid: "git-same" }),
  ]);
  const fetchImpl = (async (input: string | URL | Request) => {
    if (String(input).includes("/paths-info/")) {
      return new Response(
        JSON.stringify([
          { type: "file", path: "a.bin", oid: "git-new", size: 10 },
          { type: "file", path: "b.bin", oid: "git-same", size: 10 },
        ]),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ sha: NEW_SHA }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  await runHfUpdateChecks([dir], { fetchImpl, token: null });
  assert.equal(getHfUpdateCheck(dir).status, "drift");
  pruneHfUpdateCheckFiles(dir, new Set(["a.bin"]));
  const check = getHfUpdateCheck(dir);
  assert.equal(check.status, "in-sync");
  assert.deepEqual(check.files, [{ path: "b.bin", status: "current" }]);
  rmSync(dir, { recursive: true, force: true });
});

test("a dir without a manifest reports error", async () => {
  const dir = join(config.runtimeDir, `hf-check-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const result = await runHfUpdateChecks([dir]);
  assert.equal(result[dir]?.status, "error");
  assert.match(result[dir]?.error ?? "", /no download manifest/);
  rmSync(dir, { recursive: true, force: true });
});
