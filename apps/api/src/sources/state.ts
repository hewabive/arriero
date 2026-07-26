const activeOperations = new Map<string, string>();

export function getActiveSourceRepositoryOperation(
  sourceId: string,
): string | null {
  return activeOperations.get(sourceId) ?? null;
}

export function anySourceRepositoryOperationActive(): boolean {
  return activeOperations.size > 0;
}

export async function withSourceRepositoryOperation<T>(
  sourceId: string,
  operation: string,
  work: () => Promise<T>,
): Promise<T> {
  const active = getActiveSourceRepositoryOperation(sourceId);
  if (active) {
    throw new Error(
      `source repository operation already running for ${sourceId}: ${active}`,
    );
  }
  activeOperations.set(sourceId, operation);
  try {
    return await work();
  } finally {
    if (activeOperations.get(sourceId) === operation) {
      activeOperations.delete(sourceId);
    }
  }
}
