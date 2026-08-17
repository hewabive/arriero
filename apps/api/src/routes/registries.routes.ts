import { PackageRegistriesSettingsSchema } from "@arriero/core";
import type { Hono } from "hono";

import {
  getPackageRegistriesSettings,
  savePackageRegistriesSettings,
} from "../settings/registries.js";

export function registerRegistryRoutes(app: Hono) {
  app.get("/api/registries", (c) =>
    c.json({ data: getPackageRegistriesSettings() }),
  );

  app.put("/api/registries", async (c) => {
    const parsed = PackageRegistriesSettingsSchema.safeParse(
      await c.req.json(),
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    return c.json({ data: savePackageRegistriesSettings(parsed.data) });
  });
}
