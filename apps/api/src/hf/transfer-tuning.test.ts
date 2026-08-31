import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hfChunkBytes,
  HfConnectionTuner,
  hfInitialConnections,
  hfMaxConnections,
} from "./transfer-tuning.js";

test("automatic transfer bounds use four initial and eight maximum connections", () => {
  assert.equal(hfInitialConnections(), 4);
  assert.equal(hfMaxConnections(), 8);
});

test("automatic chunks grow with the file while staying bounded", () => {
  assert.equal(hfChunkBytes(64 * 1024 * 1024), 16 * 1024 * 1024);
  assert.equal(hfChunkBytes(1024 * 1024 * 1024), 32 * 1024 * 1024);
  assert.equal(hfChunkBytes(100 * 1024 * 1024 * 1024), 128 * 1024 * 1024);
});

test("explicit transfer bounds remain available to deterministic tests", () => {
  const overrides = {
    chunkBytes: 10,
    initialConnections: 3,
    maxConnections: 3,
  };
  assert.equal(hfChunkBytes(100, overrides), 10);
  assert.equal(hfInitialConnections(overrides), 3);
  assert.equal(hfMaxConnections(overrides), 3);
});

test("connection tuner keeps productive probes and rejects a plateau", () => {
  let now = 0;
  const changes: number[] = [];
  const tuner = new HfConnectionTuner({
    initialConnections: 4,
    maxConnections: 8,
    now: () => now,
    onChange: (connections) => changes.push(connections),
  });
  now = 1_500;
  tuner.recordBytes(15_000);
  assert.equal(tuner.connections, 5);
  now = 3_000;
  tuner.recordBytes(16_000);
  assert.equal(tuner.connections, 6);
  now = 4_500;
  tuner.recordBytes(16_000);
  assert.equal(tuner.connections, 5);
  assert.deepEqual(changes, [5, 6, 5]);
});

test("connection tuner backs off on rate limits and transport errors", () => {
  let now = 0;
  const tuner = new HfConnectionTuner({
    initialConnections: 8,
    maxConnections: 8,
    now: () => now,
    onChange: () => undefined,
  });
  tuner.recordRateLimit();
  assert.equal(tuner.connections, 4);
  now += 1_000;
  tuner.recordTransportError();
  assert.equal(tuner.connections, 3);
});
