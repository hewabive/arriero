import type { PackageRegistriesSettings } from "@arriero/core";

import { nodeRequest as request } from "./http.js";

export async function getPackageRegistriesSettings() {
  return request<{ data: PackageRegistriesSettings }>("/api/registries");
}

export async function updatePackageRegistriesSettings(
  input: PackageRegistriesSettings,
) {
  return request<{ data: PackageRegistriesSettings }>("/api/registries", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
