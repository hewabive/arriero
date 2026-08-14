import { ConfigBusyError } from "./busy.js";

let activeOperation: string | null = null;

export function getActiveConfigGitOperation(): string | null {
  return activeOperation;
}

export async function withConfigGitOperation<T>(
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  if (activeOperation) {
    throw new ConfigBusyError(
      `config git operation already running: ${activeOperation}`,
    );
  }
  activeOperation = operation;
  try {
    return await run();
  } finally {
    activeOperation = null;
  }
}
