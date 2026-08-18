import {
  cudaComputeCapabilityShortfall,
  formatComputeCapability,
  type ComputeCapability,
  type CudaVisibleDevices,
  type ProcessPreflightIssue,
  type SystemAccelerator,
} from "@arriero/core";

import { getSystemAccelerators } from "../system/resources.js";
import type { PreflightOptions } from "./preflight.js";

export function nvidiaGpuAccelerators(
  options: PreflightOptions,
): SystemAccelerator[] {
  return (options.accelerators ?? getSystemAccelerators()).filter(
    (accelerator) =>
      accelerator.kind === "gpu" && accelerator.vendor === "NVIDIA",
  );
}

export function pushCudaComputeCapabilityIssues(input: {
  issues: ProcessPreflightIssue[];
  detected: SystemAccelerator[];
  visible: CudaVisibleDevices;
  minimum: ComputeCapability;
  engineLabel: string;
  level: ProcessPreflightIssue["level"];
}) {
  const candidates =
    input.visible.mode === "list"
      ? input.detected.filter((accelerator) =>
          input.visible.ids.includes(accelerator.id),
        )
      : input.detected;
  if (input.visible.mode === "list" && candidates.length === 0) {
    return;
  }
  const shortfall = cudaComputeCapabilityShortfall(
    candidates,
    input.minimum,
    input.engineLabel,
  );
  if (!shortfall) {
    return;
  }
  if (
    cudaComputeCapabilityShortfall(
      input.detected,
      input.minimum,
      input.engineLabel,
    ) === null
  ) {
    input.issues.push({
      level: input.level,
      field: "env.CUDA_VISIBLE_DEVICES",
      message: `CUDA_VISIBLE_DEVICES selects no GPU meeting the ${input.engineLabel} compute capability ${formatComputeCapability(input.minimum)} requirement`,
    });
    return;
  }
  input.issues.push({
    level: input.level,
    field: "gpu",
    message: shortfall,
  });
}
