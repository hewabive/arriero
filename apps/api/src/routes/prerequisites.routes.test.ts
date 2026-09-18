import { PrerequisiteInstallRunSchema } from "@arriero/core";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";

import { prerequisiteInstallRunner } from "../prerequisites/install-runner.js";
import { registerPrerequisiteRoutes } from "./prerequisites.routes.js";

test("DELETE cancels an installation and latest exposes the terminal run", async (t) => {
  const app = new Hono();
  registerPrerequisiteRoutes(app);
  t.after(() => prerequisiteInstallRunner.cancel());
  const empty = await app.request("/api/prerequisites/install", {
    method: "DELETE",
  });
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { data: null });
  prerequisiteInstallRunner.start({ checkId: "uv" }, "sleep 30", null);
  const response = await app.request("/api/prerequisites/install", {
    method: "DELETE",
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const run = PrerequisiteInstallRunSchema.parse(body.data);
  assert.equal(run.status, "canceled");
  assert.ok(run.finishedAt);
  const latest = await app.request("/api/prerequisites/install/latest");
  assert.deepEqual(await latest.json(), body);
  const repeated = await app.request("/api/prerequisites/install", {
    method: "DELETE",
  });
  assert.deepEqual(await repeated.json(), body);
});
