import assert from "node:assert/strict";
import { test } from "node:test";

import {
  beeGfsToolsPackage,
  parseBeeGfsLegacyTargets,
  parseBeeGfsMountInfo,
  parseBeeGfsV8Targets,
} from "./beegfs.js";

test("parseBeeGfsMountInfo finds BeeGFS mounts and decodes escaped paths", () => {
  const mounts = parseBeeGfsMountInfo(
    [
      "35 24 0:30 / / rw,relatime - ext4 /dev/sda1 rw",
      "42 35 0:51 / /mnt/team\\040space rw,relatime shared:12 - beegfs beegfs_nodev rw,cfgFile=/etc/beegfs/client.conf",
      "43 35 0:52 / /mnt/ondemand rw,relatime - beegfs_ondemand beegfs_ondemand rw",
      "",
    ].join("\n"),
  );

  assert.deepEqual(mounts, [
    { mountPath: "/mnt/ondemand", source: "beegfs_ondemand" },
    { mountPath: "/mnt/team space", source: "beegfs_nodev" },
  ]);
});

test("parseBeeGfsLegacyTargets parses metadata and storage capacity tables", () => {
  const targets = parseBeeGfsLegacyTargets(`
METADATA SERVERS:
TargetID   Cap. Pool        Total         Free    %      ITotal       IFree    %
========   =========        =====         ====    =      ======       =====    =
       1      normal      100.0GiB       80.0GiB  80%       10.0M        8.0M  80%

STORAGE TARGETS:
TargetID   Cap. Pool        Total         Free    %      ITotal       IFree    %
========   =========        =====         ====    =      ======       =====    =
     101         low     2048.5GiB      512.2GiB  25%      200.0M      150.0M  75%
`);

  assert.equal(targets.length, 2);
  assert.deepEqual(targets[0], {
    id: "1",
    alias: null,
    node: null,
    kind: "metadata",
    storagePool: null,
    capacityPool: "normal",
    totalBytes: 100 * 1024 ** 3,
    freeBytes: 80 * 1024 ** 3,
    totalInodes: 10_000_000,
    freeInodes: 8_000_000,
  });
  assert.equal(targets[1]?.kind, "storage");
  assert.equal(targets[1]?.capacityPool, "low");
  assert.equal(targets[1]?.totalBytes, Math.round(2048.5 * 1024 ** 3));
});

test("parseBeeGfsV8Targets accepts raw JSON output from target list", () => {
  const targets = parseBeeGfsV8Targets(
    JSON.stringify([
      {
        id: { num_id: 7, node_type: 2 },
        type: 2,
        alias: "meta-a",
        node: "m:1",
        storage_pool: "(n/a)",
        cap_pool: "Normal",
        space: "1000",
        space_free: "750",
        inodes: "100",
        inodes_free: "80",
      },
      {
        id: { num_id: 21, node_type: 3 },
        type: 3,
        alias: "storage-a",
        node: "s:2",
        storage_pool: "s:1",
        cap_pool: "Emergency",
        space: "2000",
        space_free: "100",
        inodes: "-",
        inodes_free: "-",
      },
    ]),
  );

  assert.deepEqual(targets, [
    {
      id: "m:7",
      alias: "meta-a",
      node: "m:1",
      kind: "metadata",
      storagePool: null,
      capacityPool: "normal",
      totalBytes: 1000,
      freeBytes: 750,
      totalInodes: 100,
      freeInodes: 80,
    },
    {
      id: "s:21",
      alias: "storage-a",
      node: "s:2",
      kind: "storage",
      storagePool: "s:1",
      capacityPool: "emergency",
      totalBytes: 2000,
      freeBytes: 100,
      totalInodes: null,
      freeInodes: null,
    },
  ]);
});

test("BeeGFS 8 uses the new tools package and legacy versions use utils", () => {
  assert.equal(beeGfsToolsPackage("8.4.0"), "beegfs-tools");
  assert.equal(beeGfsToolsPackage("7.4.7"), "beegfs-utils");
  assert.equal(beeGfsToolsPackage(null), "beegfs-utils");
});
