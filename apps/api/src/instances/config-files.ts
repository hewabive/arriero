import {
  InstanceConfigRecordSchema,
  type InstanceConfigRecord,
  type RpcWorkerRef,
} from "@arriero/core";

import { config } from "../config.js";
import { createJsonDirectoryStore } from "../config-store/directory-store.js";
import { compareStrings } from "../utils/sort.js";

const instancesDir = config.instancesDir;

const store = createJsonDirectoryStore<InstanceConfigRecord>({
  id: "instances",
  dir: instancesDir,
  schema: InstanceConfigRecordSchema,
  key: (record) => record.name,
  portablePaths: true,
});

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) =>
      compareStrings(left, right),
    ),
  );
}

export function listInstanceRecords(): InstanceConfigRecord[] {
  return store.list();
}

export function getInstanceRecord(name: string): InstanceConfigRecord | null {
  return store.get(name);
}

export function findInstanceRecordByName(
  name: string,
): InstanceConfigRecord | null {
  return store.get(name);
}

export function writeInstanceRecord(
  record: InstanceConfigRecord,
  previousName?: string,
): void {
  const parsed = InstanceConfigRecordSchema.parse(record);
  const validated = {
    ...parsed,
    args: sortedRecord(parsed.args),
    env: sortedRecord(parsed.env),
  };
  store.write(validated, previousName);
}

export function rewriteLocalRpcWorkerRefs(
  instanceName: string,
  rewrite: (ref: RpcWorkerRef) => RpcWorkerRef | null,
): void {
  const referencesInstance = (ref: RpcWorkerRef) =>
    !ref.nodeId && ref.instanceName === instanceName;
  for (const record of listInstanceRecords()) {
    if (!record.rpcWorkers.some(referencesInstance)) {
      continue;
    }
    writeInstanceRecord({
      ...record,
      rpcWorkers: record.rpcWorkers.flatMap((ref) => {
        if (!referencesInstance(ref)) {
          return [ref];
        }
        const next = rewrite(ref);
        return next ? [next] : [];
      }),
    });
  }
}

export function removeInstanceRecord(name: string): boolean {
  return store.remove(name);
}

export function resetInstancesCache(): void {
  store.reset();
}
