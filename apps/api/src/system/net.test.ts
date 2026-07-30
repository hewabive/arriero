import { strict as assert } from "node:assert";
import test from "node:test";

import {
  computeNetworkActivity,
  isReportableInterface,
  type NetCounters,
  parseProcNetDev,
} from "./net.js";

const SAMPLE = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000      10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0
  eth0: 5000      50    0    0    0     0          0         0     2500      25    0    0    0     0       0          0
`;

test("parseProcNetDev splits receive and transmit columns", () => {
  const counters = parseProcNetDev(SAMPLE);
  assert.equal(counters.size, 2);
  assert.deepEqual(counters.get("eth0"), {
    rxBytes: 5000,
    rxPackets: 50,
    txBytes: 2500,
    txPackets: 25,
  });
});

test("isReportableInterface drops loopback and container bridges", () => {
  assert.equal(isReportableInterface("eth0"), true);
  assert.equal(isReportableInterface("enp5s0"), true);
  assert.equal(isReportableInterface("lo"), false);
  assert.equal(isReportableInterface("docker0"), false);
  assert.equal(isReportableInterface("veth1a2b"), false);
  assert.equal(isReportableInterface("br-abcdef"), false);
});

test("computeNetworkActivity derives rates from the delta", () => {
  const previous = new Map<string, NetCounters>([
    ["eth0", { rxBytes: 0, rxPackets: 0, txBytes: 0, txPackets: 0 }],
  ]);
  const current = new Map<string, NetCounters>([
    [
      "eth0",
      {
        rxBytes: 2_000_000,
        rxPackets: 2_000,
        txBytes: 500_000,
        txPackets: 500,
      },
    ],
  ]);

  const activity = computeNetworkActivity({
    previous,
    current,
    intervalMs: 2_000,
    names: ["eth0"],
    meta: new Map([["eth0", { speedMbps: 10_000, up: true }]]),
  });

  assert.deepEqual(activity.interfaces[0], {
    name: "eth0",
    rxBytesPerSec: 1_000_000,
    txBytesPerSec: 250_000,
    rxPacketsPerSec: 1_000,
    txPacketsPerSec: 250,
    speedMbps: 10_000,
    up: true,
  });
  assert.equal(activity.totalRxBytesPerSec, 1_000_000);
  assert.equal(activity.totalTxBytesPerSec, 250_000);
  assert.equal(activity.intervalMs, 2_000);
});

test("computeNetworkActivity yields null rates without a previous sample", () => {
  const current = new Map<string, NetCounters>([
    ["eth0", { rxBytes: 10, rxPackets: 1, txBytes: 10, txPackets: 1 }],
  ]);

  const activity = computeNetworkActivity({
    previous: null,
    current,
    intervalMs: 0,
    names: ["eth0"],
    meta: new Map(),
  });

  assert.equal(activity.interfaces[0]?.rxBytesPerSec, null);
  assert.equal(activity.interfaces[0]?.up, false);
  assert.equal(activity.totalRxBytesPerSec, null);
  assert.equal(activity.intervalMs, null);
});
