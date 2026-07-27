import type {
  ModelPresetDocument,
  ModelPresetFile,
  ModelPresetSummary,
  ModelPresetWrite,
} from "@arriero/core";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import { parseModelPresetIni, renderModelPresetFile } from "./ini.js";
import { presetFileHasErrors, validatePresetStructure } from "./validate.js";

const presetsDir = config.presetsDir;
const presetNamePattern = /^[A-Za-z0-9._-]+$/;

function presetPath(name: string): string {
  return resolve(presetsDir, `${name}.ini`);
}

function isValidPresetName(name: string): boolean {
  return presetNamePattern.test(name);
}

function emptyFile(): ModelPresetFile {
  return { globalArgs: {}, rootArgs: {}, entries: [] };
}

function documentFromName(name: string): ModelPresetDocument {
  const path = presetPath(name);
  const content = readFileSync(path, "utf8");
  const mtimeMs = statSync(path).mtimeMs;
  const { file, diagnostics: parseDiagnostics } = parseModelPresetIni(content);
  const diagnostics = [...parseDiagnostics, ...validatePresetStructure(file)];

  return {
    name,
    path,
    valid: !presetFileHasErrors(diagnostics),
    diagnostics,
    file,
    content,
    mtimeMs,
  };
}

function listPresetNames(): string[] {
  if (!existsSync(presetsDir)) {
    return [];
  }
  return readdirSync(presetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ini"))
    .map((entry) => entry.name.slice(0, -".ini".length))
    .filter(isValidPresetName)
    .sort((a, b) => a.localeCompare(b));
}

export function listPresets(): ModelPresetSummary[] {
  return listPresetNames().map((name) => {
    const path = presetPath(name);
    const content = readFileSync(path, "utf8");
    const { file, diagnostics } = parseModelPresetIni(content);
    const all = [...diagnostics, ...validatePresetStructure(file)];
    return {
      name,
      path,
      valid: !presetFileHasErrors(all),
      entryCount: file.entries.length,
      mtimeMs: statSync(path).mtimeMs,
    };
  });
}

export function readPreset(name: string): ModelPresetDocument | null {
  if (!isValidPresetName(name) || !existsSync(presetPath(name))) {
    return null;
  }
  return documentFromName(name);
}

export type WritePresetResult =
  | { kind: "ok"; document: ModelPresetDocument }
  | { kind: "conflict"; document: ModelPresetDocument }
  | { kind: "not-found" };

export function writePreset(
  name: string,
  input: ModelPresetWrite,
): WritePresetResult {
  if (!isValidPresetName(name) || !existsSync(presetPath(name))) {
    return { kind: "not-found" };
  }

  const path = presetPath(name);
  const currentMtime = statSync(path).mtimeMs;

  if (!input.force && input.expectedMtimeMs !== currentMtime) {
    return { kind: "conflict", document: documentFromName(name) };
  }

  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, input.content, "utf8");
  renameSync(tmpPath, path);

  return { kind: "ok", document: documentFromName(name) };
}

export type CreatePresetResult =
  | { kind: "ok"; document: ModelPresetDocument }
  | { kind: "exists" };

export function createPreset(input: { name: string }): CreatePresetResult {
  const path = presetPath(input.name);
  if (existsSync(path)) {
    return { kind: "exists" };
  }
  mkdirSync(presetsDir, { recursive: true });
  writeFileSync(path, renderModelPresetFile(emptyFile()), "utf8");
  return { kind: "ok", document: documentFromName(input.name) };
}

export function deletePreset(name: string): boolean {
  if (!isValidPresetName(name) || !existsSync(presetPath(name))) {
    return false;
  }
  rmSync(presetPath(name));
  return true;
}
