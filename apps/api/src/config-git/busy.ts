import { getActiveJob } from "../jobs/registry.js";
import { anySourceRepositoryOperationActive } from "../sources/state.js";

export class ConfigBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigBusyError";
  }
}

export function assertNoBlockingBackgroundWork(action: string): void {
  if (getActiveJob("build")) {
    throw new ConfigBusyError(
      `cannot ${action} configuration while a build is running`,
    );
  }
  if (getActiveJob("envs")) {
    throw new ConfigBusyError(
      `cannot ${action} configuration while an environment install is running`,
    );
  }
  if (anySourceRepositoryOperationActive()) {
    throw new ConfigBusyError(
      `cannot ${action} configuration while a source repository operation is running`,
    );
  }
}
