import type { ZodType } from "zod";

export function parsePersistedJson<T>(
  schema: ZodType<T>,
  json: string,
): T | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
