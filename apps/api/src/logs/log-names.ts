import type { LogFileCategory } from "@arriero/core";

export function buildLogFileName(startedAtMs: number): string {
  return `build-${startedAtMs}.log`;
}

export function environmentLogFileName(
  environmentId: string,
  startedAtMs: number,
): string {
  return `env-${environmentId}-${startedAtMs}.log`;
}

export const JOB_LOG_PATTERNS: Array<{
  category: LogFileCategory;
  pattern: RegExp;
}> = [
  { category: "build", pattern: /^build-(\d{13})\.log$/ },
  { category: "update", pattern: /^update-(\d{13})\.log$/ },
  { category: "env", pattern: /^env-.+-(\d{13})\.log$/ },
];
