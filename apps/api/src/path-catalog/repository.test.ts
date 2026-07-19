import { strict as assert } from "node:assert";
import test from "node:test";

import {
  createPathCatalogEntry,
  getPathCatalogEntry,
  updatePathCatalogEntry,
} from "./repository.js";

test("createPathCatalogEntry stores the engine kind when provided", () => {
  const entry = createPathCatalogEntry({
    kind: "binary",
    name: "vllm entrypoint",
    path: "/opt/envs/vllm-test/bin/vllm",
    engineKind: "llama-server",
  });

  assert.equal(entry.engineKind, "llama-server");
  assert.equal(getPathCatalogEntry(entry.id)?.engineKind, "llama-server");
});

test("updatePathCatalogEntry keeps, sets, and clears the engine kind", () => {
  const entry = createPathCatalogEntry({
    kind: "binary",
    name: "engine kind lifecycle",
    path: "/opt/lifecycle/bin/some-binary",
  });
  assert.equal(entry.engineKind, undefined);

  const kept = updatePathCatalogEntry(entry.id, { name: "renamed" });
  assert.equal(kept?.engineKind, undefined);

  const set = updatePathCatalogEntry(entry.id, { engineKind: "rpc-worker" });
  assert.equal(set?.engineKind, "rpc-worker");

  const untouched = updatePathCatalogEntry(entry.id, { name: "renamed again" });
  assert.equal(untouched?.engineKind, "rpc-worker");

  const cleared = updatePathCatalogEntry(entry.id, { engineKind: null });
  assert.equal(cleared?.engineKind, undefined);
  assert.equal(getPathCatalogEntry(entry.id)?.engineKind, undefined);
});

test("updatePathCatalogEntry leaves timestamps stable for a no-op", () => {
  const entry = createPathCatalogEntry({
    kind: "binary",
    name: "stable reconciliation",
    path: "/opt/stable/bin/server",
    engineKind: "llama-server",
  });
  const unchanged = updatePathCatalogEntry(entry.id, {
    name: entry.name,
    path: entry.path,
    engineKind: "llama-server",
  });
  assert.deepEqual(unchanged, entry);
});
