import {
  ApiProxyModelRecordSchema,
  ApiProxyPipelineRecordSchema,
  ApiProxySettingsSchema,
  ApiProxyTargetRecordSchema,
  AppSettingsFileSchema,
  ArgumentDefaultsSchema,
  FleetNodeSchema,
  InstanceConfigRecordSchema,
  MemoryPoolSchema,
  classifyConfigGitPath,
  type ConfigGitPortableFileKind,
  type ConfigGitValidation,
  type ConfigGitValidationIssue,
  type InstanceConfigRecord,
} from "@arriero/core";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { z } from "zod";

import { parseModelPresetIni } from "../presets/ini.js";
import { presetFileHasErrors } from "../presets/validate.js";
import { StoredEndpointSchema } from "../proxy/endpoints.js";
import { validateApiProxyPipelineGraph } from "../proxy/pipeline-validation.js";
import { StoredSourceSchema } from "../proxy/sources.js";
import { MACHINE_STATE_FILE_SCHEMAS } from "./machine-state.js";

function issuePath(root: string, path: string): string {
  return relative(root, path) || ".";
}

function jsonContentIssues(
  displayPath: string,
  content: string,
  schema: z.ZodType,
  issues: ConfigGitValidationIssue[],
): unknown {
  try {
    const parsed = JSON.parse(content) as unknown;
    const result = schema.safeParse(parsed);
    if (!result.success) {
      issues.push({ path: displayPath, message: result.error.message });
      return null;
    }
    return result.data;
  } catch (error) {
    issues.push({ path: displayPath, message: (error as Error).message });
    return null;
  }
}

function readJson(
  root: string,
  path: string,
  schema: z.ZodType,
  issues: ConfigGitValidationIssue[],
): unknown {
  if (!existsSync(path)) return null;
  return jsonContentIssues(
    issuePath(root, path),
    readFileSync(path, "utf8"),
    schema,
    issues,
  );
}

function instanceNameIssue(
  displayPath: string,
  fileName: string,
  record: InstanceConfigRecord,
): ConfigGitValidationIssue | null {
  if (record.name === fileName) {
    return null;
  }
  return {
    path: displayPath,
    message: `instance name "${record.name}" does not match file name "${fileName}"`,
  };
}

function presetContentIssues(
  displayPath: string,
  content: string,
): ConfigGitValidationIssue[] {
  const parsed = parseModelPresetIni(content);
  if (!presetFileHasErrors(parsed.diagnostics)) {
    return [];
  }
  return parsed.diagnostics
    .filter((item) => item.severity === "error")
    .map((diagnostic) => ({ path: displayPath, message: diagnostic.message }));
}

type PortableJsonKind = Exclude<
  ConfigGitPortableFileKind,
  "instance" | "preset"
>;

const portableJsonSchemas: Record<PortableJsonKind, z.ZodType> = {
  settings: AppSettingsFileSchema,
  "argument-defaults": ArgumentDefaultsSchema,
  resources: z.array(MemoryPoolSchema),
  nodes: z.array(FleetNodeSchema),
  "proxy-targets": z.array(ApiProxyTargetRecordSchema),
  "proxy-models": z.array(ApiProxyModelRecordSchema),
  "proxy-pipelines": z.array(ApiProxyPipelineRecordSchema),
  "proxy-endpoints": z.array(StoredEndpointSchema),
  "proxy-sources": z.array(StoredSourceSchema),
  "proxy-settings": ApiProxySettingsSchema,
};

function portableJsonFilePath(kind: PortableJsonKind): string {
  return kind.startsWith("proxy-")
    ? `proxy/${kind.slice("proxy-".length)}.json`
    : `${kind}.json`;
}

export function validateConfigBlob(
  path: string,
  content: string,
): ConfigGitValidationIssue[] {
  const kind = classifyConfigGitPath(path);
  if (kind === null) {
    return [{ path, message: "not a restorable configuration file" }];
  }
  if (kind === "preset") {
    return presetContentIssues(path, content);
  }
  const issues: ConfigGitValidationIssue[] = [];
  if (kind === "instance") {
    const record = jsonContentIssues(
      path,
      content,
      InstanceConfigRecordSchema,
      issues,
    ) as InstanceConfigRecord | null;
    if (record) {
      const fileName = path.slice("instances/".length, -".json".length);
      const nameIssue = instanceNameIssue(path, fileName, record);
      if (nameIssue) issues.push(nameIssue);
    }
    return issues;
  }
  jsonContentIssues(path, content, portableJsonSchemas[kind], issues);
  return issues;
}

function rejectSymlinks(
  root: string,
  directory: string,
  issues: ConfigGitValidationIssue[],
) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === ".secrets.json") continue;
    const path = resolve(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      issues.push({
        path: issuePath(root, path),
        message: "symbolic links are not allowed in portable configuration",
      });
      continue;
    }
    if (stat.isDirectory()) rejectSymlinks(root, path, issues);
  }
}

function validateInstances(
  root: string,
  issues: ConfigGitValidationIssue[],
): InstanceConfigRecord[] {
  const directory = resolve(root, "instances");
  if (!existsSync(directory)) return [];
  const instances: InstanceConfigRecord[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = resolve(directory, entry.name);
    const record = readJson(
      root,
      path,
      InstanceConfigRecordSchema,
      issues,
    ) as InstanceConfigRecord | null;
    if (!record) continue;
    const fileName = entry.name.slice(0, -".json".length);
    const nameIssue = instanceNameIssue(
      issuePath(root, path),
      fileName,
      record,
    );
    if (nameIssue) issues.push(nameIssue);
    instances.push(record);
  }
  return instances;
}

function validatePresets(root: string, issues: ConfigGitValidationIssue[]) {
  const directory = resolve(root, "presets");
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ini")) continue;
    const path = resolve(directory, entry.name);
    issues.push(
      ...presetContentIssues(issuePath(root, path), readFileSync(path, "utf8")),
    );
  }
}

export function validateConfigRoot(root: string): ConfigGitValidation {
  const issues: ConfigGitValidationIssue[] = [];
  if (!existsSync(root)) {
    return {
      valid: false,
      issues: [
        { path: ".", message: "configuration directory does not exist" },
      ],
    };
  }

  rejectSymlinks(root, root, issues);
  const portableJsonEntries = Object.entries(portableJsonSchemas) as [
    PortableJsonKind,
    z.ZodType,
  ][];
  const recognizedPaths = [
    ...portableJsonEntries
      .map(([kind]) => portableJsonFilePath(kind))
      .filter((path) => !path.startsWith("proxy/")),
    ...Object.keys(MACHINE_STATE_FILE_SCHEMAS),
    "instances",
    "presets",
    "proxy",
  ];
  if (!recognizedPaths.some((path) => existsSync(resolve(root, path)))) {
    issues.push({
      path: ".",
      message: "repository contains no recognized configuration files",
    });
  }
  const parsed: Partial<Record<PortableJsonKind, unknown>> = {};
  for (const [kind, schema] of portableJsonEntries) {
    parsed[kind] = readJson(
      root,
      resolve(root, portableJsonFilePath(kind)),
      schema,
      issues,
    );
  }
  for (const [name, schema] of Object.entries(MACHINE_STATE_FILE_SCHEMAS)) {
    readJson(root, resolve(root, name), schema, issues);
  }
  const instances = validateInstances(root, issues);
  validatePresets(root, issues);

  const resources =
    (parsed.resources as z.infer<typeof MemoryPoolSchema>[] | null) ?? [];
  const targets =
    (parsed["proxy-targets"] as
      | z.infer<typeof ApiProxyTargetRecordSchema>[]
      | null) ?? [];
  const pipelines =
    (parsed["proxy-pipelines"] as
      | z.infer<typeof ApiProxyPipelineRecordSchema>[]
      | null) ?? [];

  const resourceIds = new Set(resources.map((item) => item.id));
  for (const instance of instances) {
    for (const draw of instance.memory) {
      if (!resourceIds.has(draw.poolId)) {
        issues.push({
          path: `instances/${instance.name}.json`,
          message: `references missing resource pool "${draw.poolId}"`,
        });
      }
    }
  }

  const targetIds = new Set(targets.map((item) => item.id));
  const pipelineById = new Map(pipelines.map((item) => [item.id, item]));
  for (const pipeline of pipelines) {
    const error = validateApiProxyPipelineGraph(pipeline, {
      getPipeline: (id) => pipelineById.get(id) ?? null,
      hasTarget: (id) => targetIds.has(id),
    });
    if (error) {
      issues.push({
        path: "proxy/pipelines.json",
        message: `pipeline "${pipeline.name}": ${error}`,
      });
    }
  }

  return { valid: issues.length === 0, issues };
}
