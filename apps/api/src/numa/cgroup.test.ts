import { strict as assert } from "node:assert";
import test from "node:test";

import {
  buildPinnedShimArgs,
  resolveInstancesGroupDir,
  shellQuote,
} from "./cgroup.js";

test("shellQuote wraps and escapes single quotes", () => {
  assert.equal(shellQuote("/usr/bin/llama-server"), "'/usr/bin/llama-server'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test("buildPinnedShimArgs joins the cgroup before exec", () => {
  const args = buildPinnedShimArgs(
    "/sys/fs/cgroup/arriero-instances/srv/cgroup.procs",
    "/opt/llama-server",
    ["--model", "/m/x.gguf", "--port", "8080"],
  );
  assert.equal(args[0], "-c");
  assert.equal(
    args[1],
    "echo $$ > '/sys/fs/cgroup/arriero-instances/srv/cgroup.procs' && " +
      "exec '/opt/llama-server' '--model' '/m/x.gguf' '--port' '8080'",
  );
});

test("resolveInstancesGroupDir anchors a login session at the delegated user@ root", () => {
  assert.equal(
    resolveInstancesGroupDir(
      "/user.slice/user-1001.slice/session-3.scope",
      undefined,
    ),
    "/sys/fs/cgroup/user.slice/user-1001.slice/user@1001.service/arriero-instances",
  );
});

test("resolveInstancesGroupDir anchors at user@ when already inside it", () => {
  assert.equal(
    resolveInstancesGroupDir(
      "/user.slice/user-1001.slice/user@1001.service/app.slice/arriero.service",
      undefined,
    ),
    "/sys/fs/cgroup/user.slice/user-1001.slice/user@1001.service/arriero-instances",
  );
});

test("resolveInstancesGroupDir honors an explicit override", () => {
  assert.equal(
    resolveInstancesGroupDir("/whatever", "/sys/fs/cgroup/custom/base"),
    "/sys/fs/cgroup/custom/base",
  );
});
