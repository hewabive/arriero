import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AppVersion, UpdateFleet } from "@arriero/core";
import { Hono } from "hono";

import { registerUpdateRoutes } from "../routes/update.routes.js";
import { updateAdapter } from "./adapter.js";

test("checking updates refreshes a warm fleet cache immediately", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "arriero-fleet-check-"));
  const originalRoot = updateAdapter.rootDir;
  t.after(() => {
    updateAdapter.rootDir = originalRoot;
    rmSync(directory, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });

  function git(cwd: string, ...args: string[]) {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  const remote = join(directory, "remote");
  const local = join(directory, "local");
  git(directory, "init", "--initial-branch=main", remote);
  function commit() {
    git(
      remote,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "Update",
    );
    return git(remote, "rev-parse", "HEAD");
  }
  const initialCommit = commit();
  git(directory, "clone", remote, local);
  updateAdapter.rootDir = local;

  const app = new Hono();
  registerUpdateRoutes(app);
  async function fleet(): Promise<UpdateFleet> {
    const response = await app.request("/api/update/fleet");
    assert.equal(response.status, 200);
    return ((await response.json()) as { data: UpdateFleet }).data;
  }
  async function check(): Promise<AppVersion> {
    const response = await app.request("/api/update/check", { method: "POST" });
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      data: AppVersion;
      fetchError: string | null;
    };
    assert.equal(result.fetchError, null);
    return result.data;
  }

  assert.equal((await fleet()).upstream, null);
  const firstCheck = await check();
  const firstFleet = await fleet();
  assert.equal(firstFleet.upstream?.commit, initialCommit);
  assert.equal(firstFleet.upstream?.lastCheckedAt, firstCheck.lastCheckedAt);
  assert.equal(firstFleet.nodes[0]?.behindCount, 0);

  t.mock.timers.tick(1000);
  const newCommit = commit();
  const secondCheck = await check();
  const secondFleet = await fleet();
  assert.notEqual(secondCheck.lastCheckedAt, firstCheck.lastCheckedAt);
  assert.equal(secondFleet.upstream?.lastCheckedAt, secondCheck.lastCheckedAt);
  assert.equal(secondFleet.upstream?.commit, newCommit);
  assert.equal(secondFleet.nodes[0]?.version?.upstreamCommit, newCommit);
  assert.equal(secondFleet.nodes[0]?.behindCount, 1);
  assert.equal(secondFleet.nodes[0]?.outdated, true);
});
