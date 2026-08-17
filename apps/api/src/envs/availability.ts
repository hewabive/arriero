import {
  cudaComputeCapabilityShortfall,
  type ComputeCapability,
  type EnvironmentSpec,
  type SystemAccelerator,
} from "@arriero/core";
import { existsSync } from "node:fs";

export type EnvironmentAvailability = {
  availability: "not-installed" | "unavailable" | "usable";
  availabilityReason: string | null;
};

export type CudaEnvironmentRequirement = {
  engineLabel: string;
  minimumComputeCapability: ComputeCapability;
};

function unavailable(reason: string): EnvironmentAvailability {
  return { availability: "unavailable", availabilityReason: reason };
}

export function environmentAvailability(options: {
  accelerators: SystemAccelerator[];
  installed: boolean;
  rocmDeviceAvailable?: boolean;
  variant: EnvironmentSpec["variant"];
  cuda?: CudaEnvironmentRequirement;
}): EnvironmentAvailability {
  if (options.variant === "cuda") {
    const hasNvidia = options.accelerators.some(
      (accelerator) => accelerator.vendor === "NVIDIA",
    );
    if (!hasNvidia) {
      return unavailable(
        "CUDA variant requires an NVIDIA GPU available through NVML",
      );
    }
    if (options.cuda) {
      const shortfall = cudaComputeCapabilityShortfall(
        options.accelerators,
        options.cuda.minimumComputeCapability,
        options.cuda.engineLabel,
      );
      if (shortfall) {
        return unavailable(shortfall);
      }
    }
  }
  if (options.variant === "rocm" && !options.rocmDeviceAvailable) {
    return unavailable("ROCm variant requires an accessible /dev/kfd device");
  }
  if (!options.installed) {
    return { availability: "not-installed", availabilityReason: null };
  }
  return { availability: "usable", availabilityReason: null };
}

export function rocmDeviceAvailable() {
  return existsSync("/dev/kfd");
}
