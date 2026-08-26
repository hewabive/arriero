import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";

export async function parseJsonBody<S extends z.ZodTypeAny>(
  c: Context,
  schema: S,
): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw new HTTPException(400, {
      res: c.json({ error: parsed.error.flatten() }, 400),
    });
  }
  return parsed.data as z.infer<S>;
}
