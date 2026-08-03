import { strict as assert } from "node:assert";
import test from "node:test";

import {
  StorageResourceCache,
  capacityFromStatFs,
  parseStorageMountInfo,
  type StorageCapacity,
  type StorageMount,
} from "./storage-space.js";

const beeGfsMount: StorageMount = {
  mountPath: "/mnt/beegfs",
  source: "beegfs_nodev",
  fsType: "beegfs",
  kind: "beegfs",
  cfgFile: "/etc/beegfs/client.conf",
};

const localMount: StorageMount = {
  mountPath: "/",
  source: "/dev/nvme0n1p2",
  fsType: "ext4",
  kind: "local",
  cfgFile: null,
};

const rdma = {
  device: "mlx5_0",
  port: 1,
  receiveBytesPerSec: 100,
  transmitBytesPerSec: 200,
  intervalMs: 1_000,
};

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("parseStorageMountInfo finds local and BeeGFS storage without pseudo filesystems", () => {
  const mounts = parseStorageMountInfo(
    [
      "35 24 259:2 / / rw,relatime - ext4 /dev/nvme0n1p2 rw",
      "36 35 0:5 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw",
      "37 35 0:6 / /run rw,nosuid,nodev - tmpfs tmpfs rw",
      "38 35 0:42 / /mnt/share rw,relatime - nfs4 server:/share rw",
      "42 35 0:51 / /mnt/team\\040space rw,relatime shared:12 - beegfs beegfs_nodev rw,cfgFile=/etc/beegfs/team\\040client.conf",
      "43 35 0:52 / /mnt/ondemand rw,relatime - beegfs_ondemand beegfs_ondemand rw",
      "",
    ].join("\n"),
  );

  assert.deepEqual(mounts, [
    localMount,
    {
      mountPath: "/mnt/ondemand",
      source: "beegfs_ondemand",
      fsType: "beegfs_ondemand",
      kind: "beegfs",
      cfgFile: null,
    },
    {
      mountPath: "/mnt/team space",
      source: "beegfs_nodev",
      fsType: "beegfs",
      kind: "beegfs",
      cfgFile: "/etc/beegfs/team client.conf",
    },
  ]);
});

test("parseStorageMountInfo includes common device and overlay filesystems", () => {
  const mounts = parseStorageMountInfo(
    [
      "30 20 0:28 / / rw,relatime - overlay overlay rw",
      "31 20 8:1 / /data rw,relatime - xfs /dev/sda1 rw",
      "32 20 7:1 / /snap ro,relatime - squashfs /dev/loop1 ro",
    ].join("\n"),
  );

  assert.deepEqual(
    mounts.map((mount) => [mount.mountPath, mount.fsType]),
    [
      ["/", "overlay"],
      ["/data", "xfs"],
    ],
  );
});

test("parseStorageMountInfo excludes boot partitions and container-runtime mounts", () => {
  const mounts = parseStorageMountInfo(
    [
      "35 24 259:2 / / rw,relatime - ext4 /dev/nvme0n1p2 rw",
      "36 35 259:1 / /boot rw,relatime - ext4 /dev/nvme0n1p1 rw",
      "37 36 259:0 / /boot/efi rw,relatime - vfat /dev/nvme0n1p0 rw",
      "38 35 259:3 / /efi rw,relatime - vfat /dev/nvme0n1p3 rw",
      "39 35 0:60 / /var/lib/docker/overlay2/abc/merged rw,relatime - overlay overlay rw",
      "40 35 0:61 / /run/containerd/io.containerd.runtime.v2.task/moby/abc/rootfs rw - overlay overlay rw",
      "41 35 8:1 / /data rw,relatime - xfs /dev/sda1 rw",
    ].join("\n"),
  );

  assert.deepEqual(
    mounts.map((mount) => mount.mountPath),
    ["/", "/data"],
  );
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

test("StorageResourceCache refreshes capacity without blocking the caller", async () => {
  let now = 1_000;
  let calls = 0;
  let complete!: (capacity: StorageCapacity) => void;
  const capacity = new Promise<StorageCapacity>((resolve) => {
    complete = resolve;
  });
  const cache = new StorageResourceCache({
    readMounts: () => [localMount, beeGfsMount],
    readCapacity: () => {
      calls += 1;
      return capacity;
    },
    now: () => now,
    refreshMs: 30_000,
  });

  const initial = cache.get(rdma);
  assert.equal(initial?.filesystems[0]?.totalBytes, null);
  assert.deepEqual(initial?.rdma, rdma);
  assert.equal(calls, 2);

  cache.get(rdma);
  assert.equal(calls, 2);

  complete({
    totalBytes: 1_000,
    freeBytes: 400,
    totalInodes: null,
    freeInodes: null,
  });
  await flushPromises();

  const ready = cache.get(rdma);
  assert.equal(ready?.filesystems[0]?.totalBytes, 1_000);
  assert.equal(ready?.filesystems[1]?.freeBytes, 400);
  assert.equal(ready?.filesystems[0]?.checkedAt, new Date(now).toISOString());

  now += 30_001;
  const stale = cache.get(rdma);
  assert.equal(stale?.filesystems[0]?.totalBytes, 1_000);
  assert.equal(calls, 4);
});

test("StorageResourceCache reports errors and keeps the last capacity", async () => {
  let now = 1_000;
  let calls = 0;
  const cache = new StorageResourceCache({
    readMounts: () => [localMount],
    readCapacity: async () => {
      calls += 1;
      if (calls > 1) {
        throw new Error("Timed out");
      }
      return {
        totalBytes: 2_000,
        freeBytes: 500,
        totalInodes: 100,
        freeInodes: 50,
      };
    },
    now: () => now,
    refreshMs: 30_000,
  });

  cache.get(rdma);
  await flushPromises();
  now += 30_001;
  cache.get(rdma);
  await flushPromises();

  const stale = cache.get(rdma);
  assert.equal(stale?.filesystems[0]?.totalBytes, 2_000);
  assert.equal(stale?.filesystems[0]?.error, "Timed out");
  assert.equal(stale?.rdma, null);
});

test("StorageResourceCache stays absent without reportable storage", () => {
  const cache = new StorageResourceCache({
    readMounts: () => [],
    readCapacity: async () => {
      throw new Error("must not run");
    },
  });

  assert.equal(cache.get(rdma), null);
});
