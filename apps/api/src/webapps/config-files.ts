import { basename } from "node:path";

import {
  WebappConfigRecordSchema,
  type WebappConfigRecord,
} from "@arriero/core";

import { config } from "../config.js";
import { createJsonDirectoryStore } from "../config-store/directory-store.js";
import { compareStrings } from "../utils/sort.js";

const store = createJsonDirectoryStore<WebappConfigRecord>({
  id: "webapps",
  dir: config.webappsConfigDir,
  schema: WebappConfigRecordSchema,
  key: (record) => record.name,
  portablePaths: false,
});

function sortedExtraEnv(record: WebappConfigRecord): WebappConfigRecord {
  return {
    ...record,
    settings: {
      ...record.settings,
      extraEnv: Object.fromEntries(
        Object.entries(record.settings.extraEnv).sort(([left], [right]) =>
          compareStrings(left, right),
        ),
      ),
    },
  };
}

export function listWebappRecords(): WebappConfigRecord[] {
  return store.list();
}

export function getWebappRecord(name: string): WebappConfigRecord | null {
  return store.get(name);
}

export function writeWebappRecord(
  record: WebappConfigRecord,
  previousName?: string,
): void {
  const parsed = WebappConfigRecordSchema.parse(record);
  store.write(sortedExtraEnv(parsed), previousName);
}

export function removeWebappRecord(name: string): boolean {
  return store.remove(name);
}

export function listQuarantinedWebappNames(): string[] {
  return store.listInvalidFiles().map((error) => basename(error.path, ".json"));
}

export function resetWebappsCache(): void {
  store.reset();
}
