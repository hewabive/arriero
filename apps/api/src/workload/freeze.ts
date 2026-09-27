import {
  WORKLOAD_DATASET_FORMAT_VERSION,
  type WorkloadDatasetContent,
  type WorkloadDatasetFreezeRequest,
  type WorkloadDatasetRecord,
  type WorkloadDatasetSegment,
  type WorkloadDatasetSelection,
  type WorkloadFreezeJob,
  type WorkloadProfileWindow,
  type WorkloadRecord,
  type WorkloadSelectionPreview,
  type WorkloadTimeRange,
} from "@arriero/core";

import { getActiveJob, registerActiveJob } from "../jobs/registry.js";
import { readApiProxyRequestFile } from "../proxy/request-files.js";
import { getAppVersion } from "../update/version.js";
import { errorMessage } from "../utils/error-message.js";
import { newId } from "../utils/id.js";
import {
  decomposeWorkloadBody,
  workloadDatasetId,
  workloadDatasetRecord,
} from "./dataset-codec.js";
import { stageWorkloadDataset } from "./dataset-store.js";
import { buildWorkloadProfile } from "./profile.js";
import { WORKLOAD_NORMALIZATION_VERSION } from "./record-analysis.js";
import { getWorkloadRecord, listWorkloadRecords } from "./repository.js";
import {
  planWorkloadSegments,
  summarizeWorkloadSegment,
  type WorkloadSegmentPlan,
  type WorkloadSegmentPlanResult,
} from "./segments.js";

const FREEZE_JOB_DOMAIN = "workload-freeze";
const YIELD_EVERY = 10;

export class WorkloadSelectionError extends Error {}

export class WorkloadFreezeConflictError extends Error {}

let latestJob: WorkloadFreezeJob | null = null;

function scopeOf(selection: WorkloadDatasetSelection) {
  return {
    sourceId: selection.sourceId ?? undefined,
    modelId: selection.modelId ?? undefined,
    targetId: selection.targetId ?? undefined,
  };
}

function planSelection(
  selection: WorkloadDatasetSelection,
): WorkloadSegmentPlanResult {
  const scope = scopeOf(selection);
  return planWorkloadSegments({
    windows: selection.windows,
    recordsByWindow: selection.windows.map((window) =>
      listWorkloadRecords({ ...scope, from: window.from, to: window.to }),
    ),
    lookup: getWorkloadRecord,
  });
}

export function previewWorkloadSelection(
  selection: WorkloadDatasetSelection,
): WorkloadSelectionPreview {
  const plan = planSelection(selection);
  return {
    segments: plan.segments.map(summarizeWorkloadSegment),
    records: plan.segments.reduce(
      (total, segment) => total + segment.records.length,
      0,
    ),
    problems: plan.problems,
    warnings: plan.warnings,
  };
}

export function currentWorkloadFreezeJob(): WorkloadFreezeJob | null {
  return latestJob ? { ...latestJob } : null;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function periodProfile(
  records: WorkloadRecord[],
  ranges: WorkloadTimeRange[],
): WorkloadProfileWindow | null {
  const starts = ranges.map((range) => Date.parse(range.from));
  const ends = ranges.map((range) => Date.parse(range.to));
  const fromMs = Math.min(...starts);
  const toMs = Math.max(...ends);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    return null;
  }
  const span = toMs - fromMs;
  return buildWorkloadProfile(records, {
    fromMs,
    toMs,
    windowMs: span,
    stepMs: span,
  }).period;
}

function selectionNames(
  plan: WorkloadSegmentPlanResult,
  selection: WorkloadDatasetSelection,
) {
  const records = plan.segments.flatMap((segment) => segment.records);
  const source = selection.sourceId
    ? records.find((record) => record.sourceId === selection.sourceId)
    : undefined;
  const target = selection.targetId
    ? records.find((record) => record.targetId === selection.targetId)
    : undefined;
  return {
    sourceName: source?.sourceName ?? null,
    targetName: target?.targetName ?? null,
  };
}

async function datasetRecord(input: {
  record: WorkloadRecord;
  windowFromMs: number;
  previous: WorkloadRecord | null;
  write: (hash: string, json: string) => void;
}): Promise<WorkloadDatasetRecord> {
  const captured = input.record.capturePath
    ? readApiProxyRequestFile(input.record.capturePath)
    : null;
  if (!captured) {
    throw new Error(
      `the capture of request ${input.record.traceId} is no longer readable`,
    );
  }
  const body = decomposeWorkloadBody(
    captured.protocol,
    captured.data,
    input.write,
  );
  if (!body) {
    throw new Error(
      `the capture of request ${input.record.traceId} carries no messages`,
    );
  }
  return workloadDatasetRecord({
    record: input.record,
    captured,
    body,
    windowFromMs: input.windowFromMs,
    previous: input.previous,
  });
}

async function runFreeze(input: {
  job: WorkloadFreezeJob;
  request: WorkloadDatasetFreezeRequest;
  plan: WorkloadSegmentPlanResult;
  signal: AbortSignal;
}): Promise<void> {
  const { job, request, plan, signal } = input;
  const staging = await stageWorkloadDataset();
  const pendingWrites: Array<Promise<void>> = [];
  const queued = new Set<string>();
  const write = (hash: string, json: string) => {
    if (!queued.has(hash)) {
      queued.add(hash);
      pendingWrites.push(staging.writeBlob(hash, json));
    }
  };
  try {
    const segments: WorkloadDatasetSegment[] = [];
    for (const segmentPlan of plan.segments) {
      segments.push(await freezeSegment(segmentPlan, job, write, signal));
      await Promise.all(pendingWrites.splice(0));
    }
    const names = selectionNames(plan, request.selection);
    const content: WorkloadDatasetContent = {
      formatVersion: WORKLOAD_DATASET_FORMAT_VERSION,
      normalizationVersion: WORKLOAD_NORMALIZATION_VERSION,
      selection: {
        windows: request.selection.windows,
        sourceId: request.selection.sourceId,
        sourceName: names.sourceName,
        modelId: request.selection.modelId,
        targetId: request.selection.targetId,
        targetName: names.targetName,
      },
      segments,
    };
    const id = workloadDatasetId(content);
    const scope = scopeOf(request.selection);
    const populationProfile = request.population
      ? periodProfile(
          listWorkloadRecords({
            ...scope,
            from: request.population.from,
            to: request.population.to,
          }),
          [request.population],
        )
      : null;
    await staging.commit({
      id,
      meta: {
        name: request.name,
        description: request.description,
        createdAt: new Date().toISOString(),
        arrieroVersion: getAppVersion().shortCommit,
        population: request.population,
        profile: periodProfile(
          plan.segments.flatMap((segment) => segment.records),
          request.selection.windows,
        ),
        populationProfile,
        warnings: plan.warnings,
      },
      content,
    });
    job.status = "succeeded";
    job.datasetId = id;
  } catch (error) {
    await Promise.allSettled(pendingWrites);
    await staging.discard();
    job.status = signal.aborted ? "canceled" : "failed";
    job.error = signal.aborted ? "canceled" : errorMessage(error);
  } finally {
    job.finishedAt = new Date().toISOString();
  }
}

async function freezeSegment(
  segmentPlan: WorkloadSegmentPlan,
  job: WorkloadFreezeJob,
  write: (hash: string, json: string) => void,
  signal: AbortSignal,
): Promise<WorkloadDatasetSegment> {
  const windowFromMs = Date.parse(segmentPlan.window.from);
  const priming = segmentPlan.priming
    ? await datasetRecord({
        record: segmentPlan.priming,
        windowFromMs,
        previous: null,
        write,
      })
    : null;
  if (segmentPlan.priming) {
    job.processedRecords += 1;
  }
  const records: WorkloadDatasetRecord[] = [];
  let previous: WorkloadRecord | null = null;
  for (const record of segmentPlan.records) {
    if (signal.aborted) {
      throw new Error("canceled");
    }
    records.push(
      await datasetRecord({ record, windowFromMs, previous, write }),
    );
    previous = record;
    job.processedRecords += 1;
    if (job.processedRecords % YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
  }
  return {
    sessionId: segmentPlan.sessionId,
    windowIndex: segmentPlan.windowIndex,
    sourceName: segmentPlan.sourceName,
    modelId: segmentPlan.modelId,
    priming,
    primingEndedAt: segmentPlan.priming?.endAt ?? null,
    records,
  };
}

export function startWorkloadDatasetFreeze(
  request: WorkloadDatasetFreezeRequest,
): WorkloadFreezeJob {
  if (getActiveJob(FREEZE_JOB_DOMAIN)) {
    throw new WorkloadFreezeConflictError(
      "a dataset freeze is already running",
    );
  }
  const plan = planSelection(request.selection);
  if (plan.problems.length > 0) {
    throw new WorkloadSelectionError(plan.problems.join("; "));
  }
  const job: WorkloadFreezeJob = {
    id: newId(),
    status: "running",
    name: request.name,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    processedRecords: 0,
    totalRecords: plan.segments.reduce(
      (total, segment) =>
        total + segment.records.length + (segment.priming ? 1 : 0),
      0,
    ),
    datasetId: null,
    error: null,
  };
  latestJob = job;
  const controller = new AbortController();
  const completion = runFreeze({
    job,
    request,
    plan,
    signal: controller.signal,
  });
  registerActiveJob({
    domain: FREEZE_JOB_DOMAIN,
    jobId: job.id,
    cancel: () => controller.abort(),
    completion,
  });
  return { ...job };
}

export async function waitForWorkloadFreeze(): Promise<void> {
  await getActiveJob(FREEZE_JOB_DOMAIN)?.completion;
}
