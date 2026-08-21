import {
  HfDownloadFileSchema,
  HfDownloadQueueJobSchema,
  HfLfsInfoSchema,
} from "@arriero/core";
import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import { config } from "../config.js";
import { logger } from "../logger.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { readValidatedJsonFile } from "../utils/json-file.js";

const HfQueueFileSchema = HfDownloadFileSchema.extend({
  oid: z.string().min(1),
  lfs: HfLfsInfoSchema.nullable(),
  lastCommitId: z.string().nullable(),
  lastCommitDate: z.string().nullable(),
});

const HfQueueStoredJobSchema = HfDownloadQueueJobSchema.omit({
  connections: true,
  downloadedBytes: true,
  transfer: true,
}).extend({
  files: z.array(HfQueueFileSchema),
});

const HfQueueStoreFileSchema = z.object({
  version: z.literal(1),
  queue: z.array(HfQueueStoredJobSchema),
  history: z.array(HfQueueStoredJobSchema),
});

export type HfQueueJob = z.infer<typeof HfQueueStoredJobSchema>;
export type HfQueueStoreState = z.infer<typeof HfQueueStoreFileSchema>;

function hfQueueStorePath(): string {
  return resolve(config.dataDir, "hf-download-queue.json");
}

export function loadHfQueueStore(): HfQueueStoreState {
  const path = hfQueueStorePath();
  if (!existsSync(path)) {
    return { version: 1, queue: [], history: [] };
  }
  const parsed = readValidatedJsonFile(
    path,
    HfQueueStoreFileSchema,
    "hf download queue file",
  );
  if (parsed) {
    return parsed;
  }
  logger.error(
    { path },
    "hf download queue file is invalid; quarantining and starting with an empty queue",
  );
  try {
    renameSync(path, `${path}.invalid`);
  } catch (error) {
    logger.warn({ path, err: error }, "could not quarantine hf queue file");
  }
  return { version: 1, queue: [], history: [] };
}

export function persistHfQueueStore(state: HfQueueStoreState): void {
  atomicWriteFile(hfQueueStorePath(), `${JSON.stringify(state, null, 2)}\n`);
}
