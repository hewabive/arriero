import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import {
  ConfigFileError,
  ConfigWriteConflictError,
} from "./config-store/errors.js";
import { logger } from "./logger.js";

export function registerErrorHandler(app: Hono) {
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return error.getResponse();
    }
    if (error instanceof ConfigFileError) {
      logger.error(
        { configFile: error.path, stage: error.stage },
        error.message,
      );
      return c.json(
        { error: { message: error.message, configFile: error.path } },
        500,
      );
    }
    if (error instanceof ConfigWriteConflictError) {
      return c.json({ error: error.message }, 409);
    }
    if (error instanceof SyntaxError) {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    logger.error({ error }, "unhandled api error");
    return c.json({ error: "internal error" }, 500);
  });
}
