import { strict as assert } from "node:assert";
import test from "node:test";

import {
  BeeGfsResourceCache,
  capacityFromStatFs,
  parseBeeGfsMountInfo,
  type BeeGfsCapacity,
} from "./beegfs.js";

const mount = {
  mountPath: "/mnt/beegfs",
  source: "beegfs_nodev",
  cfgFile: "/etc/beegfs/client.conf",
};

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("parseBeeGfsMountInfo finds BeeGFS mounts and reads cfgFile", () => {
  const mounts = parseBeeGfsMountInfo(
    [
      "35 24 0:30 / / rw,relatime - ext4 /dev/sda1 rw",
      "42 35 0:51 / /mnt/team\\040space rw,relatime shared:12 - beegfs beegfs_nodev rw,cfgFile=/etc/beegfs/team\\040client.conf",
      "43 35 0:52 / /mnt/ondemand rw,relatime - beegfs_ondemand beegfs_ondemand rw",
      "",
    ].join("\n"),
  );

  assert.deepEqual(mounts, [
    {
      mountPath: "/mnt/ondemand",
      source: "beegfs_ondemand",
      cfgFile: null,
    },
    {
      mountPath: "/mnt/team space",
      source: "beegfs_nodev",
      cfgFile: "/etc/beegfs/team client.conf",
    },
  ]);
});

test("capacityFromStatFs converts blocks to bytes and hides unsupported inodes", () => {
  assert.deepEqual(
    capacityFromStatFs({
      bsize: 4_096n,
      blocks: 1_000n,
      bavail: 250n,
      files: 0n,
      ffree: 0n,
    }),
    {
      totalBytes: 4_096_000,
      freeBytes: 1_024_000,
      totalInodes: null,
      freeInodes: null,
    },
  );
});

test("capacityFromStatFs preserves supported inode counters", () => {
  const capacity = capacityFromStatFs({
    bsize: 1n,
    blocks: 10n,
    bavail: 4n,
    files: 100n,
    ffree: 60n,
  });

  assert.equal(capacity.totalInodes, 100);
  assert.equal(capacity.freeInodes, 60);
});

test("BeeGfsResourceCache refreshes capacity without blocking the caller", async () => {
  let now = 1_000;
  let calls = 0;
  let complete!: (capacity: BeeGfsCapacity) => void;
  const capacity = new Promise<BeeGfsCapacity>((resolve) => {
    complete = resolve;
  });
  const cache = new BeeGfsResourceCache({
    readMounts: () => [mount],
    readCapacity: () => {
      calls += 1;
      return capacity;
    },
    now: () => now,
    refreshMs: 30_000,
  });

  const initial = cache.get(null);
  assert.equal(initial?.status, "collecting");
  assert.equal(initial?.filesystems[0]?.totalBytes, null);
  assert.equal(calls, 1);

  cache.get(null);
  assert.equal(calls, 1);

  complete({
    totalBytes: 1_000,
    freeBytes: 400,
    totalInodes: null,
    freeInodes: null,
  });
  await flushPromises();

  const ready = cache.get(null);
  assert.equal(ready?.status, "ready");
  assert.equal(ready?.filesystems[0]?.totalBytes, 1_000);
  assert.equal(ready?.filesystems[0]?.freeBytes, 400);
  assert.equal(ready?.filesystems[0]?.checkedAt, new Date(now).toISOString());

  now += 30_001;
  const stale = cache.get(null);
  assert.equal(stale?.filesystems[0]?.totalBytes, 1_000);
  assert.equal(calls, 2);
});

test("BeeGfsResourceCache reports a failed initial refresh per mount", async () => {
  const cache = new BeeGfsResourceCache({
    readMounts: () => [mount],
    readCapacity: async () => {
      throw new Error("Host is down");
    },
    now: () => 1_000,
  });

  assert.equal(cache.get(null)?.status, "collecting");
  await flushPromises();

  const failed = cache.get(null);
  assert.equal(failed?.status, "error");
  assert.equal(failed?.filesystems[0]?.error, "Host is down");
});

test("BeeGfsResourceCache keeps the last capacity after a refresh failure", async () => {
  let now = 1_000;
  let calls = 0;
  const cache = new BeeGfsResourceCache({
    readMounts: () => [mount],
    readCapacity: async () => {
      calls += 1;
      if (calls > 1) {
        throw new Error("Timed out");
      }
      return {
        totalBytes: 2_000,
        freeBytes: 500,
        totalInodes: null,
        freeInodes: null,
      };
    },
    now: () => now,
    refreshMs: 30_000,
  });

  cache.get(null);
  await flushPromises();
  now += 30_001;
  assert.equal(cache.get(null)?.filesystems[0]?.totalBytes, 2_000);
  await flushPromises();

  const stale = cache.get(null);
  assert.equal(stale?.status, "ready");
  assert.equal(stale?.filesystems[0]?.totalBytes, 2_000);
  assert.equal(stale?.filesystems[0]?.error, "Timed out");
});

test("BeeGfsResourceCache stays absent when BeeGFS is not mounted", () => {
  const cache = new BeeGfsResourceCache({
    readMounts: () => [],
    readCapacity: async () => {
      throw new Error("must not run");
    },
  });

  assert.equal(cache.get(null), null);
});
