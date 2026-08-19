import { readFileSync } from "node:fs";

import { z } from "zod";

const BuildInfoSchema = z.object({
  commit: z.string().nullable(),
  builtAt: z.string(),
});

const buildInfoUrl = new URL("../build-info.json", import.meta.url);

export function readDistBuildCommit(): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(buildInfoUrl, "utf8"));
    const parsed = BuildInfoSchema.safeParse(raw);
    return parsed.success ? parsed.data.commit : null;
  } catch {
    return null;
  }
}

const commitLoadedAtStart = readDistBuildCommit();

export function runningBuildCommit(): string | null {
  return commitLoadedAtStart;
}

export type BuildSyncFlags = {
  buildPending: boolean | null;
  restartPending: boolean | null;
};

export function buildSyncFlags(input: {
  headCommit: string | null;
  distCommit: string | null;
  runningCommit: string | null;
}): BuildSyncFlags {
  return {
    buildPending:
      input.headCommit !== null && input.distCommit !== null
        ? input.distCommit !== input.headCommit
        : null,
    restartPending:
      input.distCommit !== null && input.runningCommit !== null
        ? input.runningCommit !== input.distCommit
        : null,
  };
}
