import type { InstanceArgs } from "@arriero/core";

const httpsInstanceArgs = new Set([
  "-mu",
  "--model-url",
  "-dr",
  "--docker-repo",
  "-hf",
  "-hfr",
  "--hf-repo",
  "-hfd",
  "-hfrd",
  "--spec-draft-hf",
  "--hf-repo-draft",
  "--ssl-key-file",
  "--ssl-cert-file",
]);

export function instanceArgsNeedHttps(args: InstanceArgs): boolean {
  return Object.entries(args).some(
    ([name, value]) =>
      httpsInstanceArgs.has(name) &&
      value !== false &&
      value !== null &&
      value !== "",
  );
}
