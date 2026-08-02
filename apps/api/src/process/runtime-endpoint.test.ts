import type { Instance } from "@arriero/core";
import assert from "node:assert/strict";
import test from "node:test";

import { instanceBaseUrl, rpcWorkerEndpoint } from "../instances/endpoint.js";
import { getApiEndpointById, instanceEndpointId } from "../proxy/endpoints.js";
import {
  createProcessRun,
  deleteProcessRunsForInstance,
} from "./runs-repository.js";
import {
  buildLaunchSnapshot,
  serializeLaunchSnapshot,
} from "./launch-snapshot.js";
import {
  runtimeEndpointInstance,
  runtimeInstanceBaseUrl,
  runtimeRpcWorkerEndpoint,
} from "./runtime-endpoint.js";

function makeInstance(
  kind: Instance["kind"],
  args: Instance["args"],
  name = `runtime-endpoint-${kind}`,
): Instance {
  return {
    name,
    kind,
    binaryPath: `/opt/${kind}`,
    binaryPathRefId: `${kind}-binary`,
    status: "running",
    pid: 123,
    args,
    env: {},
    memory: [],
    rpcWorkers: [],
  };
}

function activeRun(instance: Instance) {
  return {
    status: "running",
    launchSnapshot: serializeLaunchSnapshot(buildLaunchSnapshot(instance)),
  };
}

test("running llama-server keeps its launch host, port and API prefix after edits", () => {
  const launched = makeInstance("llama-server", {
    "--host": "127.0.0.1",
    "--port": 8080,
    "--api-prefix": "/old",
  });
  const edited = {
    ...launched,
    args: {
      "--host": "0.0.0.0",
      "--port": 9090,
      "--api-prefix": "/new",
    },
  };

  assert.equal(instanceBaseUrl(edited), "http://127.0.0.1:9090/new");
  assert.equal(
    runtimeInstanceBaseUrl(edited, activeRun(launched)),
    "http://127.0.0.1:8080/old",
  );
  assert.deepEqual(edited.args, {
    "--host": "0.0.0.0",
    "--port": 9090,
    "--api-prefix": "/new",
  });
});

test("running vLLM and KTransformers use their launch endpoints", () => {
  const cases = [
    {
      launched: makeInstance("vllm", {}),
      editedArgs: { "--host": "0.0.0.0", "--port": 5174 },
      expected: "http://127.0.0.1:8000",
    },
    {
      launched: makeInstance("ktransformers", {
        "--host": "127.0.0.1",
        "--port": 30001,
      }),
      editedArgs: { "--host": "0.0.0.0", "--port": 30002 },
      expected: "http://127.0.0.1:30001",
    },
  ] as const;

  for (const { launched, editedArgs, expected } of cases) {
    const edited = { ...launched, args: editedArgs };
    assert.equal(runtimeInstanceBaseUrl(edited, activeRun(launched)), expected);
  }
});

test("running rpc-worker resolves the effective launch alias", () => {
  const launched = makeInstance("rpc-worker", {
    "--host": "127.0.0.1",
    "-p": 50053,
  });
  const edited = {
    ...launched,
    args: { "--host": "0.0.0.0", "--port": 50054 },
  };

  assert.deepEqual(rpcWorkerEndpoint(edited), {
    host: "127.0.0.1",
    port: 50054,
  });
  assert.deepEqual(runtimeRpcWorkerEndpoint(edited, activeRun(launched)), {
    host: "127.0.0.1",
    port: 50053,
  });
});

test("inactive or snapshot-less runs use the saved endpoint", () => {
  const instance = makeInstance("vllm", {
    "--host": "0.0.0.0",
    "--port": 5174,
  });

  assert.equal(
    runtimeEndpointInstance(instance, {
      status: "exited",
      launchSnapshot: activeRun(instance).launchSnapshot,
    }),
    instance,
  );
  assert.equal(
    runtimeEndpointInstance(instance, {
      status: "running",
      launchSnapshot: null,
    }),
    instance,
  );
});

test("managed proxy endpoint follows the active launch snapshot", () => {
  const name = "runtime-endpoint-proxy-vllm";
  const launched = makeInstance("vllm", { "--port": 8001 }, name);
  const edited = { ...launched, args: { "--port": 5174 } };
  createProcessRun({
    instanceId: name,
    pid: 123,
    status: "running",
    startedAt: "2026-07-30T00:00:00.000Z",
    logPath: `/tmp/${name}.log`,
    rawLogPath: null,
    launchSnapshot: activeRun(launched).launchSnapshot,
  });

  try {
    assert.equal(
      getApiEndpointById(instanceEndpointId(name), [edited])?.baseUrl,
      "http://127.0.0.1:8001/v1",
    );
  } finally {
    deleteProcessRunsForInstance(name);
  }
});
