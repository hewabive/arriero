import {
  ApiProxyConfigSchema,
  ApiProxyModelConfigSchema,
  ApiProxyModelCreateSchema,
  ApiProxyModelRecordSchema,
  ApiProxyModelUpdateSchema,
  ApiProxyPipelineCreateSchema,
  ApiProxyPipelineConfigSchema,
  ApiProxyPipelineRecordSchema,
  ApiProxyPipelineUpdateSchema,
  ApiProxyQuickRouteCreateSchema,
  ApiProxyTargetConfigSchema,
  ApiProxyTargetCreateSchema,
  ApiProxyTargetRecordSchema,
  ApiProxyTargetUpdateSchema,
  type ApiProxyConfig,
  type ApiProxyModelCreate,
  type ApiProxyModelRecord,
  type ApiProxyModelUpdate,
  type ApiProxyPipelineCreate,
  type ApiProxyPipelineRecord,
  type ApiProxyPipelineUpdate,
  type ApiProxyQuickRouteCreate,
  type ApiProxyQuickRouteResult,
  type ApiProxyTargetCreate,
  type ApiProxyTargetRecord,
  type ApiProxyTargetUpdate,
} from "@arriero/core";
import { newId } from "../utils/id.js";
import { sortedByKey } from "../utils/sort.js";
import { readCollection, writeCollection } from "./config-files.js";
import { deleteApiProxyRuntimeMetadata } from "./runtime-metadata-store.js";

export {
  addApiProxySavedSlotId,
  apiProxySlotFilename,
  deleteApiProxyRuntimeMetadata,
  getApiProxyRuntimeMetadata,
  listApiProxyRuntimeMetadata,
  removeApiProxySavedSlotId,
  setApiProxyRuntimeMetadata,
} from "./runtime-metadata-store.js";

export const TARGETS_FILE = "targets.json";
export const MODELS_FILE = "models.json";
export const PIPELINES_FILE = "pipelines.json";

function readTargets(): ApiProxyTargetRecord[] {
  return readCollection(TARGETS_FILE, ApiProxyTargetRecordSchema);
}

function readModels(): ApiProxyModelRecord[] {
  return readCollection(MODELS_FILE, ApiProxyModelRecordSchema);
}

function readPipelines(): ApiProxyPipelineRecord[] {
  return readCollection(PIPELINES_FILE, ApiProxyPipelineRecordSchema);
}

function persistTargets(records: ApiProxyTargetRecord[]) {
  writeCollection(
    TARGETS_FILE,
    sortedByKey(records, (item) => item.name),
  );
}

function persistModels(records: ApiProxyModelRecord[]) {
  writeCollection(
    MODELS_FILE,
    sortedByKey(records, (item) => item.modelId),
  );
}

function persistPipelines(records: ApiProxyPipelineRecord[]) {
  writeCollection(
    PIPELINES_FILE,
    sortedByKey(records, (item) => item.name),
  );
}

export function rewriteApiProxyCollections(
  files: string[] = [TARGETS_FILE, MODELS_FILE, PIPELINES_FILE],
): void {
  if (files.includes(TARGETS_FILE)) persistTargets(readTargets());
  if (files.includes(MODELS_FILE)) persistModels(readModels());
  if (files.includes(PIPELINES_FILE)) persistPipelines(readPipelines());
}

export function listApiProxyTargets(): ApiProxyTargetRecord[] {
  return [...readTargets()].sort(
    (left, right) =>
      right.priority - left.priority || left.name.localeCompare(right.name),
  );
}

export function listApiProxyModels(): ApiProxyModelRecord[] {
  return [...readModels()].sort((left, right) =>
    left.modelId.localeCompare(right.modelId),
  );
}

export function listApiProxyPipelines(): ApiProxyPipelineRecord[] {
  return [...readPipelines()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export function getApiProxyTarget(id: string): ApiProxyTargetRecord | null {
  return readTargets().find((target) => target.id === id) ?? null;
}

export function getApiProxyModel(id: string): ApiProxyModelRecord | null {
  return readModels().find((model) => model.id === id) ?? null;
}

export function getApiProxyPipeline(id: string): ApiProxyPipelineRecord | null {
  return readPipelines().find((pipeline) => pipeline.id === id) ?? null;
}

export function getApiProxyModelByModelId(
  modelId: string,
): ApiProxyModelRecord | null {
  return readModels().find((model) => model.modelId === modelId) ?? null;
}

export function getApiProxyConfig(): ApiProxyConfig {
  return ApiProxyConfigSchema.parse({
    models: listApiProxyModels(),
    pipelines: listApiProxyPipelines(),
    targets: listApiProxyTargets(),
  });
}

function assertUniqueTargetName(
  records: ApiProxyTargetRecord[],
  name: string,
  exceptId: string | null,
) {
  if (records.some((item) => item.name === name && item.id !== exceptId)) {
    throw new Error(`API proxy target name already exists: ${name}`);
  }
}

function assertUniqueModelId(
  records: ApiProxyModelRecord[],
  modelId: string,
  exceptId: string | null,
) {
  if (
    records.some((item) => item.modelId === modelId && item.id !== exceptId)
  ) {
    throw new Error(`API proxy model id already exists: ${modelId}`);
  }
}

function assertUniquePipelineName(
  records: ApiProxyPipelineRecord[],
  name: string,
  exceptId: string | null,
) {
  if (records.some((item) => item.name === name && item.id !== exceptId)) {
    throw new Error(`API proxy pipeline name already exists: ${name}`);
  }
}

export function createApiProxyTarget(
  input: ApiProxyTargetCreate,
): ApiProxyTargetRecord {
  const parsed = ApiProxyTargetCreateSchema.parse(input);
  const records = readTargets();
  assertUniqueTargetName(records, parsed.name, null);
  const record = ApiProxyTargetRecordSchema.parse({
    ...parsed,
    id: newId(),
  });
  persistTargets([...records, record]);
  return record;
}

export function updateApiProxyTarget(
  id: string,
  input: ApiProxyTargetUpdate,
): ApiProxyTargetRecord | null {
  const records = readTargets();
  const current = records.find((target) => target.id === id);
  if (!current) {
    return null;
  }
  const parsed = ApiProxyTargetUpdateSchema.parse(input);
  const merged = ApiProxyTargetConfigSchema.parse({
    ...current,
    ...parsed,
    id: current.id,
  });
  assertUniqueTargetName(records, merged.name, id);
  const next = ApiProxyTargetRecordSchema.parse(merged);
  persistTargets(records.map((target) => (target.id === id ? next : target)));
  return next;
}

export function deleteApiProxyTarget(id: string): boolean {
  const records = readTargets();
  if (!records.some((target) => target.id === id)) {
    return false;
  }
  persistTargets(records.filter((target) => target.id !== id));

  const models = readModels();
  if (models.some((model) => model.targetId === id)) {
    persistModels(
      models.map((model) =>
        model.targetId === id ? { ...model, targetId: null } : model,
      ),
    );
  }

  deleteApiProxyRuntimeMetadata(id);
  return true;
}

export function createApiProxyModel(
  input: ApiProxyModelCreate,
): ApiProxyModelRecord {
  const parsed = ApiProxyModelCreateSchema.parse(input);
  const records = readModels();
  assertUniqueModelId(records, parsed.modelId, null);
  const record = ApiProxyModelRecordSchema.parse({
    ...parsed,
    id: newId(),
  });
  persistModels([...records, record]);
  return record;
}

export function createApiProxyQuickRoute(
  input: ApiProxyQuickRouteCreate,
): ApiProxyQuickRouteResult {
  const parsed = ApiProxyQuickRouteCreateSchema.parse(input);
  assertUniqueModelId(readModels(), parsed.modelId, null);
  const target = createApiProxyTarget(
    ApiProxyTargetCreateSchema.parse({
      name: parsed.targetName,
      endpointId: parsed.endpointId,
      model: parsed.model,
    }),
  );
  try {
    const model = createApiProxyModel(
      ApiProxyModelCreateSchema.parse({
        modelId: parsed.modelId,
        visible: true,
        enabled: true,
        targetId: target.id,
        routeTo: { type: "target", id: target.id },
      }),
    );
    return { target, model };
  } catch (error) {
    deleteApiProxyTarget(target.id);
    throw error;
  }
}

export function updateApiProxyModel(
  id: string,
  input: ApiProxyModelUpdate,
): ApiProxyModelRecord | null {
  const records = readModels();
  const current = records.find((model) => model.id === id);
  if (!current) {
    return null;
  }
  const parsed = ApiProxyModelUpdateSchema.parse(input);
  const merged = ApiProxyModelConfigSchema.parse({
    ...current,
    ...parsed,
    id: current.id,
  });
  assertUniqueModelId(records, merged.modelId, id);
  const next = ApiProxyModelRecordSchema.parse(merged);
  persistModels(records.map((model) => (model.id === id ? next : model)));
  return next;
}

export function deleteApiProxyModel(id: string): boolean {
  const records = readModels();
  if (!records.some((model) => model.id === id)) {
    return false;
  }
  persistModels(records.filter((model) => model.id !== id));
  return true;
}

export function createApiProxyPipeline(
  input: ApiProxyPipelineCreate,
): ApiProxyPipelineRecord {
  const parsed = ApiProxyPipelineCreateSchema.parse(input);
  const records = readPipelines();
  assertUniquePipelineName(records, parsed.name, null);
  const record = ApiProxyPipelineRecordSchema.parse({
    ...parsed,
    id: newId(),
  });
  persistPipelines([...records, record]);
  return record;
}

export function updateApiProxyPipeline(
  id: string,
  input: ApiProxyPipelineUpdate,
): ApiProxyPipelineRecord | null {
  const records = readPipelines();
  const current = records.find((pipeline) => pipeline.id === id);
  if (!current) {
    return null;
  }
  const parsed = ApiProxyPipelineUpdateSchema.parse(input);
  const merged = ApiProxyPipelineConfigSchema.parse({
    ...current,
    ...parsed,
    id: current.id,
  });
  assertUniquePipelineName(records, merged.name, id);
  const next = ApiProxyPipelineRecordSchema.parse(merged);
  persistPipelines(
    records.map((pipeline) => (pipeline.id === id ? next : pipeline)),
  );
  return next;
}

export function deleteApiProxyPipeline(id: string): boolean {
  const records = readPipelines();
  if (!records.some((pipeline) => pipeline.id === id)) {
    return false;
  }
  persistPipelines(records.filter((pipeline) => pipeline.id !== id));
  return true;
}
