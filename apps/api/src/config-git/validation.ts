import {
  ApiProxyModelRecordSchema,
  ApiProxyPipelineRecordSchema,
  ApiProxySettingsSchema,
  ApiProxyTargetRecordSchema,
  AppSettingsFileSchema,
  ArgumentDefaultsSchema,
  BenchmarkPromptSchema,
  EnvironmentSpecSchema,
  FleetNodeSchema,
  InstanceConfigRecordSchema,
  MemoryPoolDeclarationSchema,
  ModelRequirementSchema,
  WebappConfigRecordSchema,
  classifyConfigGitPath,
  configGitInstanceName,
  configGitWebappName,
  engineDescriptor,
  instanceIdFromEndpointId,
  type ConfigGitPortableFileKind,
  type ConfigGitValidation,
  type ConfigGitValidationIssue,
  type InstanceConfigRecord,
  type WebappConfigRecord,
} from "@arriero/core";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { z } from "zod";

import { parseModelPresetIni } from "../presets/ini.js";
import { presetFileHasErrors } from "../presets/validate.js";
import { validateInstanceRpcWorkers } from "../instances/validation.js";
import {
  StoredEndpointSchema,
  managerProxyEndpointId,
  parseRemoteEndpointId,
} from "../proxy/endpoints.js";
import {
  validateApiProxyModelRouteBinding,
  validateApiProxyPipelineGraph,
} from "../proxy/pipeline-validation.js";
import { StoredSourceSchema } from "../proxy/sources.js";
import { isManagerProxyBaseUrl } from "../proxy/targets.js";
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

function webappNameIssue(
  displayPath: string,
  fileName: string,
  record: WebappConfigRecord,
): ConfigGitValidationIssue | null {
  if (record.name === fileName) {
    return null;
  }
  return {
    path: displayPath,
    message: `webapp name "${record.name}" does not match file name "${fileName}"`,
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
  "instance" | "preset" | "webapp"
>;

type EndpointRefResolution =
  | "manager"
  | "managed-instance"
  | "remote"
  | "external"
  | null;

function createEndpointRefResolver(context: {
  instances: InstanceConfigRecord[];
  nodeIds: Set<string>;
  storedEndpointIds: Set<string>;
}): (id: string) => EndpointRefResolution {
  const instanceByName = new Map(
    context.instances.map((item) => [item.name, item]),
  );
  return (id) => {
    if (id === managerProxyEndpointId) {
      return "manager";
    }
    const instanceName = instanceIdFromEndpointId(id);
    if (instanceName !== null) {
      const instance = instanceByName.get(instanceName);
      return instance && engineDescriptor(instance.kind).proxy.serveEndpoint
        ? "managed-instance"
        : null;
    }
    const remote = parseRemoteEndpointId(id);
    if (remote) {
      return context.nodeIds.has(remote.nodeId) ? "remote" : null;
    }
    return context.storedEndpointIds.has(id) ? "external" : null;
  };
}

const portableJsonSchemas: Record<PortableJsonKind, z.ZodType> = {
  settings: AppSettingsFileSchema,
  "argument-defaults": ArgumentDefaultsSchema,
  resources: z.array(MemoryPoolDeclarationSchema),
  nodes: z.array(FleetNodeSchema),
  environments: z.array(EnvironmentSpecSchema),
  models: z.array(ModelRequirementSchema),
  "benchmark-prompts": z.array(BenchmarkPromptSchema),
  "proxy-targets": z.array(ApiProxyTargetRecordSchema),
  "proxy-models": z.array(ApiProxyModelRecordSchema),
  "proxy-pipelines": z.array(ApiProxyPipelineRecordSchema),
  "proxy-endpoints": z.array(StoredEndpointSchema),
  "proxy-sources": z.array(StoredSourceSchema),
  "proxy-settings": ApiProxySettingsSchema,
};

function portableJsonFilePath(kind: PortableJsonKind): string {
  if (kind === "environments") {
    return "envs.json";
  }
  if (kind === "benchmark-prompts") {
    return "benchmark/prompts.json";
  }
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
    const fileName = configGitInstanceName(path);
    if (record && fileName !== null) {
      const nameIssue = instanceNameIssue(path, fileName, record);
      if (nameIssue) issues.push(nameIssue);
    }
    return issues;
  }
  if (kind === "webapp") {
    const record = jsonContentIssues(
      path,
      content,
      WebappConfigRecordSchema,
      issues,
    ) as WebappConfigRecord | null;
    const fileName = configGitWebappName(path);
    if (record && fileName !== null) {
      const nameIssue = webappNameIssue(path, fileName, record);
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

function validateWebapps(
  root: string,
  issues: ConfigGitValidationIssue[],
): WebappConfigRecord[] {
  const directory = resolve(root, "webapps");
  if (!existsSync(directory)) return [];
  const webapps: WebappConfigRecord[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = resolve(directory, entry.name);
    const record = readJson(
      root,
      path,
      WebappConfigRecordSchema,
      issues,
    ) as WebappConfigRecord | null;
    if (!record) continue;
    const fileName = entry.name.slice(0, -".json".length);
    const nameIssue = webappNameIssue(issuePath(root, path), fileName, record);
    if (nameIssue) issues.push(nameIssue);
    webapps.push(record);
  }
  return webapps;
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
    "webapps",
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
  const webapps = validateWebapps(root, issues);
  validatePresets(root, issues);

  const resources =
    (parsed.resources as
      | z.infer<typeof MemoryPoolDeclarationSchema>[]
      | null) ?? [];
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

  const modelRequirements =
    (parsed.models as z.infer<typeof ModelRequirementSchema>[] | null) ?? [];
  const seenRequirementIds = new Set<string>();
  for (const requirement of modelRequirements) {
    if (seenRequirementIds.has(requirement.id)) {
      issues.push({
        path: "models.json",
        message: `duplicate model requirement id "${requirement.id}"`,
      });
    }
    seenRequirementIds.add(requirement.id);
  }

  const environmentSpecs = parsed.environments as
    | z.infer<typeof EnvironmentSpecSchema>[]
    | null;
  const envSpecIds = environmentSpecs
    ? new Set(environmentSpecs.map((item) => item.id))
    : null;
  const proxySourceIds = new Set(
    (
      (parsed["proxy-sources"] as
        | z.infer<typeof StoredSourceSchema>[]
        | null) ?? []
    ).map((item) => item.id),
  );
  for (const webapp of webapps) {
    if (
      webapp.proxySourceId !== null &&
      !proxySourceIds.has(webapp.proxySourceId)
    ) {
      issues.push({
        path: `webapps/${webapp.name}.json`,
        message: `references missing proxy source "${webapp.proxySourceId}"`,
      });
    }
    if (envSpecIds && !envSpecIds.has(webapp.envSpecId)) {
      issues.push({
        path: `webapps/${webapp.name}.json`,
        message: `references missing environment spec "${webapp.envSpecId}"`,
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

  const models =
    (parsed["proxy-models"] as
      | z.infer<typeof ApiProxyModelRecordSchema>[]
      | null) ?? [];
  const endpoints =
    (parsed["proxy-endpoints"] as
      | z.infer<typeof StoredEndpointSchema>[]
      | null) ?? [];
  const nodes =
    (parsed.nodes as z.infer<typeof FleetNodeSchema>[] | null) ?? [];
  const resolveEndpointRef = createEndpointRefResolver({
    instances,
    nodeIds: new Set(nodes.map((item) => item.id)),
    storedEndpointIds: new Set(endpoints.map((item) => item.id)),
  });

  for (const instance of instances) {
    const rpcWorkersIssue = validateInstanceRpcWorkers(instance);
    if (rpcWorkersIssue) {
      issues.push({
        path: `instances/${instance.name}.json`,
        message: rpcWorkersIssue,
      });
    }
  }

  for (const target of targets) {
    const resolution = resolveEndpointRef(target.endpointId);
    if (resolution === null) {
      issues.push({
        path: "proxy/targets.json",
        message: `target "${target.name}" references missing endpoint "${target.endpointId}"`,
      });
    } else if (resolution === "manager") {
      issues.push({
        path: "proxy/targets.json",
        message: `target "${target.name}" cannot point to arriero proxy itself`,
      });
    } else if (resolution === "managed-instance" && target.model) {
      issues.push({
        path: "proxy/targets.json",
        message: `target "${target.name}" is a managed instance: leave the model empty (it is implied by the instance)`,
      });
    }
  }

  for (const model of models) {
    if (model.targetId && !targetIds.has(model.targetId)) {
      issues.push({
        path: "proxy/models.json",
        message: `model "${model.modelId}" references missing target "${model.targetId}"`,
      });
    }
    const routeTo = model.routeTo;
    if (routeTo?.type === "target" && !targetIds.has(routeTo.id)) {
      issues.push({
        path: "proxy/models.json",
        message: `model "${model.modelId}" routes to missing target "${routeTo.id}"`,
      });
    }
    if (routeTo?.type === "pipeline" && !pipelineById.has(routeTo.id)) {
      issues.push({
        path: "proxy/models.json",
        message: `model "${model.modelId}" routes to missing pipeline "${routeTo.id}"`,
      });
    }
    if (
      routeTo?.type === "endpoint" &&
      resolveEndpointRef(routeTo.endpointId) === null
    ) {
      issues.push({
        path: "proxy/models.json",
        message: `model "${model.modelId}" routes to missing endpoint "${routeTo.endpointId}"`,
      });
    }
    const binding = validateApiProxyModelRouteBinding({
      routeTo,
      getPipeline: (id) => pipelineById.get(id) ?? null,
    });
    if (binding) {
      issues.push({
        path: "proxy/models.json",
        message: `model "${model.modelId}": ${binding}`,
      });
    }
  }

  for (const endpoint of endpoints) {
    if (isManagerProxyBaseUrl(endpoint.baseUrl)) {
      issues.push({
        path: "proxy/endpoints.json",
        message: `endpoint "${endpoint.name}" cannot point to arriero proxy itself`,
      });
    }
  }

  return { valid: issues.length === 0, issues };
}
