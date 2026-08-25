import { WebappConfigRecordSchema } from "@arriero/core";
import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../config.js";
import {
  buildWebappLaunchSnapshot,
  hasWebappLaunchDrift,
  parseWebappLaunchSnapshot,
  serializeWebappLaunchSnapshot,
} from "./launch.js";
import { renderWebappEnvironment } from "./render.js";

function record(overrides: Record<string, unknown> = {}) {
  return WebappConfigRecordSchema.parse({
    name: "render-test",
    kind: "open-webui",
    envSpecId: "env-spec-render",
    http: { host: "127.0.0.1", port: 3000 },
    settings: { type: "open-webui" },
    ...overrides,
  });
}

test("open-webui render pins the deterministic contract", () => {
  const env = renderWebappEnvironment(record());
  assert.equal(env.ENABLE_PERSISTENT_CONFIG, "False");
  assert.equal(env.ENABLE_OLLAMA_API, "False");
  assert.equal(env.OPENAI_API_BASE_URL, `http://127.0.0.1:${config.port}/v1`);
  assert.equal(env.WEBUI_AUTH, "True");
  assert.equal(env.RAG_EMBEDDING_ENGINE, "openai");
  assert.equal(env.AUDIO_STT_ENGINE, "openai");
  assert.ok(env.DATA_DIR?.endsWith("/render-test"));
  assert.equal("DEFAULT_MODELS" in env, false);
});

test("open-webui render honours settings toggles and extraEnv", () => {
  const env = renderWebappEnvironment(
    record({
      settings: {
        type: "open-webui",
        auth: false,
        slim: false,
        defaultModels: ["qwen3", "glm-4.5"],
        extraEnv: { WEBUI_NAME: "Home LLM" },
      },
    }),
  );
  assert.equal(env.WEBUI_AUTH, "False");
  assert.equal("RAG_EMBEDDING_ENGINE" in env, false);
  assert.equal(env.DEFAULT_MODELS, "qwen3,glm-4.5");
  assert.equal(env.WEBUI_NAME, "Home LLM");
});

test("chat-ui render wires the proxy and keeps the embedded MongoDB local", () => {
  const env = renderWebappEnvironment(
    record({
      name: "chat",
      kind: "chat-ui",
      http: { host: "127.0.0.1", port: 3001 },
      settings: { type: "chat-ui" },
    }),
  );
  assert.equal(env.OPENAI_BASE_URL, `http://127.0.0.1:${config.port}/v1`);
  assert.equal(env.ENABLE_CONFIG_MANAGER, "false");
  assert.equal(env.COOKIE_SECURE, "false");
  assert.ok(env.MONGO_STORAGE_PATH?.endsWith("/chat/db"));
  assert.ok(env.MONGOMS_DOWNLOAD_DIR?.endsWith("/chat/mongodb-binaries"));
  assert.equal("MODELS" in env, false);
  assert.equal("MONGODB_URL" in env, false);
});

test("chat-ui render appends extraEnv, including an external MongoDB", () => {
  const env = renderWebappEnvironment(
    record({
      name: "chat",
      kind: "chat-ui",
      settings: {
        type: "chat-ui",
        extraEnv: {
          MONGODB_URL: "mongodb://127.0.0.1:27017",
          PUBLIC_APP_NAME: "Home Chat",
        },
      },
    }),
  );
  assert.equal(env.MONGODB_URL, "mongodb://127.0.0.1:27017");
  assert.equal(env.PUBLIC_APP_NAME, "Home Chat");
});

test("chat-ui launch snapshot carries only host and port flags", () => {
  const { snapshot } = buildWebappLaunchSnapshot(
    record({
      name: "chat",
      kind: "chat-ui",
      http: { host: "127.0.0.1", port: 3001 },
      settings: { type: "chat-ui" },
    }),
    "/envs/chat-ui/bin/chat-ui",
  );
  assert.deepEqual(snapshot.cliArgs, ["--host", "127.0.0.1", "--port", "3001"]);
});

test("launch snapshot round-trips and detects drift", () => {
  const entrypoint = "/envs/open-webui/bin/open-webui";
  const base = record();
  const { snapshot } = buildWebappLaunchSnapshot(base, entrypoint);
  assert.deepEqual(snapshot.cliArgs, [
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    "3000",
  ]);

  const parsed = parseWebappLaunchSnapshot(
    serializeWebappLaunchSnapshot(snapshot),
  );
  assert.deepEqual(parsed, snapshot);

  assert.equal(hasWebappLaunchDrift(base, entrypoint, snapshot), false);
  assert.equal(
    hasWebappLaunchDrift(
      record({ http: { host: "127.0.0.1", port: 3001 } }),
      entrypoint,
      snapshot,
    ),
    true,
  );
  assert.equal(
    hasWebappLaunchDrift(
      record({ settings: { type: "open-webui", auth: false } }),
      entrypoint,
      snapshot,
    ),
    true,
  );
  assert.equal(
    hasWebappLaunchDrift(
      record({ envSpecId: "env-spec-other" }),
      entrypoint,
      snapshot,
    ),
    true,
  );
});
