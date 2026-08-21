import { readFileSync } from "node:fs";

import { readPciNumaNode } from "../numa/topology.js";
import { nvidiaTelemetry } from "./telemetry.js";

function readProcessName(pid: number): string | null {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return argv[0] || null;
  } catch {
    return null;
  }
}

const status = nvidiaTelemetry.status(true);
const devices = nvidiaTelemetry.accelerators().map((device) => ({
  ...device,
  numaNode: device.pciBusId ? readPciNumaNode(device.pciBusId) : null,
}));
const processes = nvidiaTelemetry.computeProcesses().map((processInfo) => ({
  ...processInfo,
  processName: readProcessName(processInfo.pid),
}));

console.log(
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      status,
      devices,
      processes,
    },
    null,
    2,
  ),
);

nvidiaTelemetry.close();
if (status.state !== "ready") {
  process.exitCode = 1;
}
