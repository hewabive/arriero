import { strict as assert } from "node:assert";
import test from "node:test";

import {
  cgroupControllersHaveCpuset,
  findDelegatedRootPath,
  parseSelfCgroupV2Path,
} from "./capability.js";
import {
  normalizePciAddress,
  parseCpuListCount,
  parseNodeMeminfo,
} from "./topology.js";

test("parseCpuListCount sums ranges and singletons", () => {
  assert.equal(parseCpuListCount("0-17,36-53"), 36);
  assert.equal(parseCpuListCount("4"), 1);
  assert.equal(parseCpuListCount(""), 0);
});

test("parseNodeMeminfo reads per-node MemTotal, MemFree and FilePages", () => {
  const meminfo = [
    "Node 0 MemTotal:      134217728 kB",
    "Node 0 MemFree:         1048576 kB",
    "Node 0 FilePages:      67108864 kB",
  ].join("\n");
  assert.deepEqual(parseNodeMeminfo(meminfo), {
    memTotalBytes: 134217728 * 1024,
    memFreeBytes: 1048576 * 1024,
    filePagesBytes: 67108864 * 1024,
  });
  assert.deepEqual(parseNodeMeminfo("Node 1 MemTotal: 0 kB"), {
    memTotalBytes: 0,
    memFreeBytes: 0,
    filePagesBytes: 0,
  });
});

test("normalizePciAddress shrinks the NVML domain to sysfs form", () => {
  assert.equal(normalizePciAddress("00000000:01:00.0"), "0000:01:00.0");
  assert.equal(normalizePciAddress("0000:81:00.0"), "0000:81:00.0");
  assert.equal(normalizePciAddress("not-a-bdf"), null);
});

test("parseSelfCgroupV2Path extracts the unified path", () => {
  assert.equal(
    parseSelfCgroupV2Path("0::/user.slice/user-1001.slice/session.scope"),
    "/user.slice/user-1001.slice/session.scope",
  );
  assert.equal(parseSelfCgroupV2Path("1:cpuset:/legacy"), null);
});

test("cgroupControllersHaveCpuset detects the cpuset controller", () => {
  assert.equal(cgroupControllersHaveCpuset("cpuset cpu io memory pids"), true);
  assert.equal(cgroupControllersHaveCpuset("cpu memory pids"), false);
});

test("findDelegatedRootPath resolves the delegated user@ root", () => {
  assert.equal(
    findDelegatedRootPath("/user.slice/user-1001.slice/session-3.scope"),
    "/user.slice/user-1001.slice/user@1001.service",
  );
  assert.equal(
    findDelegatedRootPath(
      "/user.slice/user-1001.slice/user@1001.service/app.slice/x.service",
    ),
    "/user.slice/user-1001.slice/user@1001.service",
  );
  assert.equal(findDelegatedRootPath("/system.slice/x.service"), null);
});
