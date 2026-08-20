import {
  HfDownloadFileSchema,
  HfDownloadQueueJobSchema,
  HfLfsInfoSchema,
} from "@arriero/core";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import { config } from "../config.js";
import { logger } from "../logger.js";
import { atomicWriteFile } from "../utils/atomic-write.js";

const HfQueueFileSchema = HfDownloadFileSchema.extend({
  oid: z.string().min(1),
  lfs: HfLfsInfoSchema.nullable(),
  lastCommitId: z.string().nullable(),
  lastCommitDate: z.string().nullable(),
});

const HfQueueStoredJobSchema = HfDownloadQueueJobSchema.omit({
  activePaths: true,
  connections: true,
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
  try {
    const parsed = HfQueueStoreFileSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    if (parsed.success) {
      return parsed.data;
    }
    logger.error(
      { path, issues: parsed.error.issues.slice(0, 5) },
      "hf download queue file failed validation; starting with an empty queue",
    );
  } catch (error) {
    logger.error(
      { path, err: error },
      "hf download queue file is not valid JSON; starting with an empty queue",
    );
  }
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
