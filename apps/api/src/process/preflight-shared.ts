import type { Instance, ProcessPreflightIssue } from "@arriero/core";
import { isAbsolute } from "node:path";

export function issue(
  issues: ProcessPreflightIssue[],
  level: ProcessPreflightIssue["level"],
  field: string,
  message: string,
) {
  issues.push({ level, field, message });
}

export function instanceArgNumber(
  instance: Instance,
  keys: string[],
  fallback: number,
) {
  for (const key of keys) {
    const value = instance.args[key];
    if (value === undefined || value === null || value === false) continue;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return fallback;
}

export function configuredInstanceArg(instance: Instance, keys: string[]) {
  for (const key of keys) {
    const value = instance.args[key];
    if (value !== undefined && value !== null && value !== false) {
      return { key, value };
    }
  }
  return null;
}

export function isExplicitPath(value: string): boolean {
  return isAbsolute(value) || value.startsWith("./") || value.startsWith("../");
}
