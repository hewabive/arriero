import type { EnvironmentJobStep, EnvironmentJobStepName } from "@arriero/core";

export function pendingJobStep(
  name: EnvironmentJobStepName,
  command: string[],
): EnvironmentJobStep {
  return {
    name,
    command,
    status: "pending",
    startedAt: null,
    finishedAt: null,
    exitCode: null,
  };
}
