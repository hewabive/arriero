import assert from "node:assert/strict";
import test from "node:test";

import { virtualizationFromProbe } from "./virtualization.js";

test("virtualizationFromProbe reports the detected VM type", () => {
  assert.deepEqual(
    virtualizationFromProbe({ status: 0, stdout: "kvm\n", cpuinfo: "" }),
    { type: "kvm" },
  );
});

test("virtualizationFromProbe falls back to the hypervisor CPU flag", () => {
  assert.deepEqual(
    virtualizationFromProbe({
      status: 1,
      stdout: "none\n",
      cpuinfo: "flags: fpu hypervisor avx2\n",
    }),
    { type: "unknown" },
  );
});

test("virtualizationFromProbe ignores bare metal", () => {
  assert.equal(
    virtualizationFromProbe({
      status: 1,
      stdout: "none\n",
      cpuinfo: "flags: fpu avx2\n",
    }),
    null,
  );
});
