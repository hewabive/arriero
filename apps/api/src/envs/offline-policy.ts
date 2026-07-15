import type { EnvironmentSpec } from "@llama-manager/core";

const publicHosts = new Set([
  "astral.sh",
  "files.pythonhosted.org",
  "github.com",
  "pypi.org",
  "pythonhosted.org",
  "releases.astral.sh",
]);

function publicUrl(value: string | null): string | null {
  if (!value) return null;
  const url = new URL(value);
  return publicHosts.has(url.hostname.toLowerCase()) ? value : null;
}

export function offlineEnvironmentPolicyError(
  spec: Pick<EnvironmentSpec, "pythonMirrorUrl" | "pythonProvisioning" | "source">,
): string | null {
  if (spec.pythonProvisioning !== "mirror") return null;
  if (!spec.pythonMirrorUrl) return "Python mirror provisioning requires pythonMirrorUrl";
  const publicMirror = publicUrl(spec.pythonMirrorUrl);
  if (publicMirror) return `Python runtime mirror points at a public host: ${publicMirror}`;

  if (spec.source.kind === "pypi") {
    if (!spec.source.indexUrl) {
      return "Offline PyPI installation requires an explicit closed-network index URL";
    }
    const publicIndex = publicUrl(spec.source.indexUrl);
    return publicIndex ? `Python package index points at a public host: ${publicIndex}` : null;
  }

  const publicWheel = publicUrl(spec.source.url);
  if (publicWheel) return `Root wheel points at a public host: ${publicWheel}`;
  if (!spec.source.dependencyIndexUrl) {
    return "Offline wheel installation requires a closed-network dependency index URL";
  }
  const publicIndex = publicUrl(spec.source.dependencyIndexUrl);
  return publicIndex ? `Wheel dependency index points at a public host: ${publicIndex}` : null;
}
