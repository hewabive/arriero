import { readFileSync } from "node:fs";
import type { z } from "zod";

import { logger } from "../logger.js";

export function readValidatedJsonFile<Schema extends z.ZodTypeAny>(
  path: string,
  schema: Schema,
  label: string,
): z.infer<Schema> | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    logger.warn({ path, err: error }, `${label} is not valid JSON`);
    return null;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    logger.warn(
      { path, issues: parsed.error.issues.slice(0, 5) },
      `${label} failed validation`,
    );
    return null;
  }
  return parsed.data;
}
