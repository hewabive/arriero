import type { EnvironmentSpec, SystemAccelerator } from "@llama-manager/core";
import { existsSync } from "node:fs";

export type EnvironmentAvailability = {
  availability: "not-installed" | "unavailable" | "usable";
  availabilityReason: string | null;
};

export function environmentAvailability(options: {
  accelerators: SystemAccelerator[];
  installed: boolean;
  rocmDeviceAvailable?: boolean;
  variant: EnvironmentSpec["variant"];
}): EnvironmentAvailability {
  if (!options.installed) {
    return { availability: "not-installed", availabilityReason: null };
  }
  if (options.variant === "cpu") {
    return { availability: "usable", availabilityReason: null };
  }
  if (options.variant === "cuda") {
    const hasNvidia = options.accelerators.some(
      (accelerator) =>
        accelerator.vendor === "NVIDIA" || accelerator.source === "nvidia-smi",
    );
    return hasNvidia
      ? { availability: "usable", availabilityReason: null }
      : {
          availability: "unavailable",
          availabilityReason: "CUDA variant requires an NVIDIA GPU visible to nvidia-smi",
        };
  }
  return options.rocmDeviceAvailable
    ? { availability: "usable", availabilityReason: null }
    : {
        availability: "unavailable",
        availabilityReason: "ROCm variant requires an accessible /dev/kfd device",
      };
}

export function rocmDeviceAvailable() {
  return existsSync("/dev/kfd");
}
