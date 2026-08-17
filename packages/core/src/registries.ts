import { z } from "zod";

function credentialFreeUrl(value: string) {
  try {
    const url = new URL(value);
    return !url.username && !url.password;
  } catch {
    return false;
  }
}

export function credentialFreeUrlSchema(
  label: string,
  protocols: string[],
  protocolsLabel: string,
) {
  return z
    .string()
    .url()
    .refine((value) => {
      try {
        return protocols.includes(new URL(value).protocol);
      } catch {
        return false;
      }
    }, `${label} must use ${protocolsLabel}`)
    .refine(credentialFreeUrl, `${label} must not contain credentials`);
}

const NpmRegistryUrlSchema = credentialFreeUrlSchema(
  "npm registry URL",
  ["http:", "https:"],
  "HTTP or HTTPS",
);

export const PackageRegistriesSettingsSchema = z.object({
  npmRegistryUrl: NpmRegistryUrlSchema.nullable().default(null),
});

export type PackageRegistriesSettings = z.infer<
  typeof PackageRegistriesSettingsSchema
>;

export function npmRegistryInstallOptions(registryUrl: string | null) {
  return registryUrl ? ["--registry", registryUrl] : [];
}
