import {
  ApiEndpointRecordSchema,
  ApiProxyModelRecordSchema,
  ApiProxyPipelineRecordSchema,
  ApiProxySourceRecordSchema,
  ApiProxyTargetRecordSchema,
  AppSettingsFileSchema,
  ArgumentDefaultsSchema,
  EnvironmentSpecSchema,
  FleetNodeSchema,
  InstanceConfigRecordSchema,
  MemoryPoolSchema,
  PathCatalogEntrySchema,
  type ConfigGitValidation,
  type ConfigGitValidationIssue,
  type InstanceConfigRecord,
} from "@arriero/core";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { z } from "zod";

import { parseModelPresetIni } from "../presets/ini.js";
import { presetFileHasErrors } from "../presets/validate.js";
import { validateApiProxyPipelineGraph } from "../proxy/pipeline-validation.js";

const StoredEndpointSchema = ApiEndpointRecordSchema.pick({
  id: true,
  name: true,
  enabled: true,
  baseUrl: true,
  profile: true,
  apiKeyEnvVar: true,
  authHeaderName: true,
  extraHeaders: true,
  passthrough: true,
  modelFilter: true,
  createdAt: true,
  updatedAt: true,
});

const StoredSourceSchema = ApiProxySourceRecordSchema.pick({
  id: true,
  name: true,
  enabled: true,
  note: true,
  createdAt: true,
  updatedAt: true,
});

function issuePath(root: string, path: string): string {
  return relative(root, path) || ".";
}

function readJson(
  root: string,
  path: string,
  schema: z.ZodType,
  issues: ConfigGitValidationIssue[],
): unknown {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const result = schema.safeParse(parsed);
    if (!result.success) {
      issues.push({
        path: issuePath(root, path),
        message: result.error.message,
      });
      return null;
    }
    return result.data;
  } catch (error) {
    issues.push({
      path: issuePath(root, path),
      message: (error as Error).message,
    });
    return null;
  }
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
    if (record.name !== fileName) {
      issues.push({
        path: issuePath(root, path),
        message: `instance name "${record.name}" does not match file name "${fileName}"`,
      });
    }
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
    const parsed = parseModelPresetIni(readFileSync(path, "utf8"));
    if (!presetFileHasErrors(parsed.diagnostics)) continue;
    for (const diagnostic of parsed.diagnostics.filter(
      (item) => item.severity === "error",
    )) {
      issues.push({
        path: issuePath(root, path),
        message: diagnostic.message,
      });
    }
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
  const recognizedPaths = [
    "settings.json",
    "argument-defaults.json",
    "resources.json",
    "path-catalog.json",
    "nodes.json",
    "envs.json",
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
  readJson(root, resolve(root, "settings.json"), AppSettingsFileSchema, issues);
  readJson(
    root,
    resolve(root, "argument-defaults.json"),
    ArgumentDefaultsSchema,
    issues,
  );
  const resources =
    (readJson(
      root,
      resolve(root, "resources.json"),
      z.array(MemoryPoolSchema),
      issues,
    ) as z.infer<typeof MemoryPoolSchema>[] | null) ?? [];
  const paths =
    (readJson(
      root,
      resolve(root, "path-catalog.json"),
      z.array(PathCatalogEntrySchema),
      issues,
    ) as z.infer<typeof PathCatalogEntrySchema>[] | null) ?? [];
  readJson(root, resolve(root, "nodes.json"), z.array(FleetNodeSchema), issues);
  const environments =
    (readJson(
      root,
      resolve(root, "envs.json"),
      z.array(EnvironmentSpecSchema),
      issues,
    ) as z.infer<typeof EnvironmentSpecSchema>[] | null) ?? [];
  const instances = validateInstances(root, issues);
  validatePresets(root, issues);

  const targets =
    (readJson(
      root,
      resolve(root, "proxy/targets.json"),
      z.array(ApiProxyTargetRecordSchema),
      issues,
    ) as z.infer<typeof ApiProxyTargetRecordSchema>[] | null) ?? [];
  readJson(
    root,
    resolve(root, "proxy/models.json"),
    z.array(ApiProxyModelRecordSchema),
    issues,
  );
  const pipelines =
    (readJson(
      root,
      resolve(root, "proxy/pipelines.json"),
      z.array(ApiProxyPipelineRecordSchema),
      issues,
    ) as z.infer<typeof ApiProxyPipelineRecordSchema>[] | null) ?? [];
  readJson(
    root,
    resolve(root, "proxy/endpoints.json"),
    z.array(StoredEndpointSchema),
    issues,
  );
  readJson(
    root,
    resolve(root, "proxy/sources.json"),
    z.array(StoredSourceSchema),
    issues,
  );

  const resourceIds = new Set(resources.map((item) => item.id));
  const pathIds = new Set(paths.map((item) => item.id));
  for (const instance of instances) {
    for (const draw of instance.memory) {
      if (!resourceIds.has(draw.poolId)) {
        issues.push({
          path: `instances/${instance.name}.json`,
          message: `references missing resource pool "${draw.poolId}"`,
        });
      }
    }
    if (instance.binaryPathRefId && !pathIds.has(instance.binaryPathRefId)) {
      issues.push({
        path: `instances/${instance.name}.json`,
        message: `references missing path catalog entry "${instance.binaryPathRefId}"`,
      });
    }
  }
  for (const environment of environments) {
    if (
      environment.pathCatalogEntryId &&
      !pathIds.has(environment.pathCatalogEntryId)
    ) {
      issues.push({
        path: "envs.json",
        message: `environment "${environment.id}" references missing path catalog entry "${environment.pathCatalogEntryId}"`,
      });
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
