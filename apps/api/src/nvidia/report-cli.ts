import { readPciNumaNode } from "../numa/topology.js";
import { nvidiaTelemetry } from "./telemetry.js";

const status = nvidiaTelemetry.status(true);
const devices = nvidiaTelemetry.accelerators().map((device) => ({
  ...device,
  numaNode: device.pciBusId ? readPciNumaNode(device.pciBusId) : null,
}));
const processes = nvidiaTelemetry.computeProcesses();

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
