import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createHfTransferTelemetry,
  hfTransferSnapshot,
  recordHfTransferPayload,
  recordHfTransferReset,
  recordHfTransferWire,
} from "./transfer-telemetry.js";

test("a steady stream yields a rate and an eta", () => {
  const telemetry = createHfTransferTelemetry(0);
  for (let second = 1; second <= 10; second += 1) {
    recordHfTransferWire(telemetry, 1_000_000, second * 1_000);
    recordHfTransferPayload(telemetry, 1_000_000, second * 1_000);
  }
  const snapshot = hfTransferSnapshot(telemetry, 50_000_000, 10_500);
  assert.notEqual(snapshot.payloadBps, null);
  assert.ok(Math.abs((snapshot.payloadBps ?? 0) - 1_000_000) < 100_000);
  assert.ok(snapshot.etaSeconds !== null && snapshot.etaSeconds >= 45);
  assert.ok(snapshot.etaSeconds !== null && snapshot.etaSeconds <= 60);
  assert.equal(snapshot.wireBytes, 10_000_000);
  assert.equal(snapshot.wastedBytes, 0);
  assert.equal(snapshot.stalledSeconds, null);
});

test("re-downloaded bytes surface as wasted bytes", () => {
  const telemetry = createHfTransferTelemetry(0);
  recordHfTransferWire(telemetry, 5_000, 1_000);
  recordHfTransferPayload(telemetry, 3_000, 1_000);
  const snapshot = hfTransferSnapshot(telemetry, 100_000, 1_500);
  assert.equal(snapshot.wireBytes, 5_000);
  assert.equal(snapshot.wastedBytes, 2_000);
});

test("a silent stream reports stalled with a nulled rate", () => {
  const telemetry = createHfTransferTelemetry(0);
  recordHfTransferWire(telemetry, 1_000, 500);
  recordHfTransferPayload(telemetry, 1_000, 500);
  recordHfTransferPayload(telemetry, 1_000, 1_500);
  const snapshot = hfTransferSnapshot(telemetry, 100_000, 20_000);
  assert.equal(snapshot.payloadBps, null);
  assert.equal(snapshot.etaSeconds, null);
  assert.equal(snapshot.stalledSeconds, 19);
});

test("resets are counted and no progress before the first byte counts from start", () => {
  const telemetry = createHfTransferTelemetry(0);
  recordHfTransferReset(telemetry);
  recordHfTransferReset(telemetry);
  const snapshot = hfTransferSnapshot(telemetry, 100_000, 30_000);
  assert.equal(snapshot.resetCount, 2);
  assert.equal(snapshot.stalledSeconds, 30);
  assert.equal(snapshot.payloadBps, null);
});
