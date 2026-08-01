import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  computeRdmaActivity,
  discoverActiveRdmaPorts,
  parseRdmaCounter,
  readRdmaPortCounters,
  selectSingleRdmaPort,
  type RdmaCounters,
} from "./rdma.js";

function counters(input: Partial<RdmaCounters> = {}): RdmaCounters {
  return {
    device: "mlx5_0",
    port: 1,
    receiveDataUnits: 100n,
    transmitDataUnits: 200n,
    ...input,
  };
}

function writePort(
  root: string,
  device: string,
  port: number,
  state: string,
  receive: string,
  transmit: string,
) {
  const base = join(root, device, "ports", String(port));
  mkdirSync(join(base, "counters"), { recursive: true });
  writeFileSync(join(base, "state"), state);
  writeFileSync(join(base, "counters", "port_rcv_data"), receive);
  writeFileSync(join(base, "counters", "port_xmit_data"), transmit);
}

test("parseRdmaCounter accepts only unsigned integer counters", () => {
  assert.equal(
    parseRdmaCounter("18446744073709551615\n"),
    18_446_744_073_709_551_615n,
  );
  assert.equal(parseRdmaCounter("-1"), null);
  assert.equal(parseRdmaCounter("unknown"), null);
  assert.equal(parseRdmaCounter(null), null);
});

test("computeRdmaActivity converts four-byte units into rates", () => {
  const activity = computeRdmaActivity({
    previous: counters(),
    current: counters({ receiveDataUnits: 600n, transmitDataUnits: 300n }),
    intervalMs: 2_000,
  });

  assert.deepEqual(activity, {
    device: "mlx5_0",
    port: 1,
    receiveBytesPerSec: 1_000,
    transmitBytesPerSec: 200,
    intervalMs: 2_000,
  });
});

test("computeRdmaActivity leaves a gap after reset or a port change", () => {
  const reset = computeRdmaActivity({
    previous: counters(),
    current: counters({ receiveDataUnits: 1n, transmitDataUnits: 2n }),
    intervalMs: 1_000,
  });
  const changed = computeRdmaActivity({
    previous: counters(),
    current: counters({ device: "mlx5_1" }),
    intervalMs: 1_000,
  });

  assert.equal(reset.receiveBytesPerSec, null);
  assert.equal(reset.transmitBytesPerSec, null);
  assert.equal(changed.receiveBytesPerSec, null);
  assert.equal(changed.transmitBytesPerSec, null);
});

test("selectSingleRdmaPort refuses to guess or aggregate", () => {
  const first = { device: "mlx5_0", port: 1 };
  const second = { device: "mlx5_1", port: 1 };

  assert.equal(selectSingleRdmaPort([]), null);
  assert.deepEqual(selectSingleRdmaPort([first]), first);
  assert.equal(selectSingleRdmaPort([first, second]), null);
});

test("discoverActiveRdmaPorts keeps active readable ports", () => {
  const root = mkdtempSync(join(tmpdir(), "arriero-rdma-"));
  try {
    writePort(root, "mlx5_0", 1, "4: ACTIVE\n", "100\n", "200\n");
    writePort(root, "mlx5_1", 1, "1: DOWN\n", "300\n", "400\n");

    assert.deepEqual(discoverActiveRdmaPorts(root), [
      { device: "mlx5_0", port: 1 },
    ]);
    assert.deepEqual(
      readRdmaPortCounters({ device: "mlx5_0", port: 1 }, root),
      counters(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
