import { PackageRegistriesSettingsSchema } from "@arriero/core";
import type { Hono } from "hono";

import {
  getPackageRegistriesSettings,
  savePackageRegistriesSettings,
} from "../settings/registries.js";
import { parseJsonBody } from "./validation.js";

export function registerRegistryRoutes(app: Hono) {
  app.get("/api/registries", (c) =>
    c.json({ data: getPackageRegistriesSettings() }),
  );

  app.put("/api/registries", async (c) => {
    const body = await parseJsonBody(c, PackageRegistriesSettingsSchema);
    return c.json({ data: savePackageRegistriesSettings(body) });
  });
}
