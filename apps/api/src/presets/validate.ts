import type {
  ModelPresetEntry,
  ModelPresetFile,
  PresetDiagnostic,
} from "@arriero/core";

function normalizeKey(key: string) {
  return key.trim().replace(/^-+/, "");
}

const remoteSourceKeys = new Set(["hf-repo", "hf", "hfr", "model-url", "mu"]);

function entryHasModelSource(entry: ModelPresetEntry) {
  if (entry.modelPath.trim() !== "") {
    return true;
  }
  return Object.entries(entry.extraArgs).some(
    ([key, value]) =>
      remoteSourceKeys.has(normalizeKey(key)) && value.trim() !== "",
  );
}

export function validatePresetStructure(
  file: ModelPresetFile,
): PresetDiagnostic[] {
  const diagnostics: PresetDiagnostic[] = [];
  for (const entry of file.entries) {
    if (!entryHasModelSource(entry)) {
      diagnostics.push({
        severity: "warning",
        message: `section '${entry.name}' has no model path; it only loads if the name matches an existing server model`,
        section: entry.name,
        key: null,
        line: null,
      });
    }
  }
  return diagnostics;
}

export function presetFileHasErrors(diagnostics: PresetDiagnostic[]) {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}
