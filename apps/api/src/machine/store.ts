import { MachineLocalStateSchema, type MachineLocalState } from "@arriero/core";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { config } from "../config.js";
import { createJsonFileStore } from "../config-store/file-store.js";

const store = createJsonFileStore<MachineLocalState>({
  id: "machine",
  path: resolve(config.configDir, "machine.json"),
  schema: MachineLocalStateSchema,
  missing: () => ({}),
  portablePaths: false,
  cache: "process",
});

export function updateMachineState(
  patch: Partial<MachineLocalState>,
): MachineLocalState {
  const current = store.read();
  const next = { ...current, ...patch };
  if (isDeepStrictEqual(current, next)) {
    return current;
  }
  store.write(next);
  return next;
}

export function getSelfNodeId(): string | null {
  return store.read().selfNodeId;
}
