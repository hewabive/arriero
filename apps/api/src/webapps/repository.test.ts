import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import { resetWebappsCache } from "./config-files.js";
import {
  createWebapp,
  deleteWebapp,
  getWebapp,
  listWebapps,
  updateWebapp,
  WebappConfigValidationError,
  WebappNameConflictError,
} from "./repository.js";
import { createWebappRun, latestWebappRun } from "./runs-repository.js";

let counter = 0;

function uniqueName(prefix: string) {
  counter += 1;
  return `${prefix}-${counter}`;
}

beforeEach(() => {
  resetWebappsCache();
});

test("createWebapp writes a file with descriptor defaults and no runtime fields", () => {
  const name = uniqueName("webui");
  const created = createWebapp(
    {
      name,
      kind: "open-webui",
      envSpecId: "env-spec-1",
      autostart: false,
      createProxySource: false,
    },
    null,
  );

  assert.equal(created.name, name);
  assert.equal(created.http.host, "127.0.0.1");
  assert.equal(created.http.port, 3000);
  assert.equal(created.settings.type, "open-webui");
  assert.equal(created.settings.auth, true);
  assert.equal(created.settings.slim, true);
  assert.equal(created.status, "stopped");
  assert.equal(created.envStatus, "missing-spec");
  assert.equal(created.configDrift, false);

  const filePath = resolve(config.webappsConfigDir, `${name}.json`);
  assert.ok(existsSync(filePath));
  const stored = JSON.parse(readFileSync(filePath, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal("status" in stored, false);
  assert.equal("pid" in stored, false);
  assert.equal("envStatus" in stored, false);
});

test("createWebapp rejects a duplicate name", () => {
  const name = uniqueName("webui");
  const input = {
    name,
    kind: "open-webui" as const,
    envSpecId: "env-spec-1",
    autostart: false,
    createProxySource: false,
  };
  createWebapp(input, null);
  assert.throws(() => createWebapp(input, null), WebappNameConflictError);
});

test("reserved extraEnv keys are rejected", () => {
  assert.throws(
    () =>
      createWebapp(
        {
          name: uniqueName("webui"),
          kind: "open-webui",
          envSpecId: "env-spec-1",
          autostart: false,
          createProxySource: false,
          settings: {
            type: "open-webui",
            auth: true,
            slim: true,
            defaultModels: [],
            extraEnv: { OPENAI_API_BASE_URL: "http://elsewhere" },
          },
        },
        null,
      ),
    WebappConfigValidationError,
  );
});

test("rename cascades to run history", () => {
  const name = uniqueName("webui");
  createWebapp(
    {
      name,
      kind: "open-webui",
      envSpecId: "env-spec-1",
      autostart: false,
      createProxySource: false,
    },
    null,
  );
  createWebappRun({
    webappId: name,
    pid: null,
    status: "exited",
    startedAt: new Date().toISOString(),
    logPath: `/tmp/${name}.log`,
    rawLogPath: null,
  });

  const nextName = uniqueName("webui-renamed");
  const updated = updateWebapp(name, { name: nextName });
  assert.equal(updated?.name, nextName);
  assert.equal(getWebapp(name), null);
  assert.ok(latestWebappRun(nextName));
  assert.equal(latestWebappRun(name), null);
});

test("deleteWebapp removes the record and its runs", () => {
  const name = uniqueName("webui");
  createWebapp(
    {
      name,
      kind: "open-webui",
      envSpecId: "env-spec-1",
      autostart: false,
      createProxySource: false,
    },
    null,
  );
  createWebappRun({
    webappId: name,
    pid: null,
    status: "exited",
    startedAt: new Date().toISOString(),
    logPath: `/tmp/${name}.log`,
    rawLogPath: null,
  });

  assert.equal(deleteWebapp(name), true);
  assert.equal(getWebapp(name), null);
  assert.equal(latestWebappRun(name), null);
  assert.equal(
    listWebapps().some((webapp) => webapp.name === name),
    false,
  );
});
