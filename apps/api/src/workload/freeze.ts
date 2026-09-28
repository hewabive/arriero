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
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import { getActiveJob, registerActiveJob } from "../jobs/registry.js";
import { createLatestJobStore } from "../jobs/store.js";
import { readApiProxyRequestFile } from "../proxy/request-files.js";
import { getAppVersion } from "../update/version.js";
import { errorMessage } from "../utils/error-message.js";
import { newId } from "../utils/id.js";
import {
  decomposeWorkloadBody,
  workloadDatasetId,
  workloadDatasetRecord,
  type WorkloadBlobSink,
} from "./dataset-codec.js";
import { stageWorkloadDataset } from "./dataset-store.js";
import {
  describeWorkloadPeriod,
  type WorkloadProfileRecord,
} from "./profile.js";
import {
  WORKLOAD_NORMALIZATION_VERSION,
  type ReplayableWorkloadRecord,
} from "./record-analysis.js";
import {
  getWorkloadRecord,
  listWorkloadProfileRecords,
  listWorkloadRecords,
} from "./repository.js";
import {
  planWorkloadSegments,
  summarizeWorkloadSegment,
  type WorkloadSegmentPlan,
  type WorkloadSegmentPlanResult,
} from "./segments.js";

const FREEZE_JOB_DOMAIN = "workload-freeze";

export class WorkloadSelectionError extends Error {}

export class WorkloadFreezeConflictError extends Error {}

const latestJob = createLatestJobStore<WorkloadFreezeJob>();

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
  return latestJob.get(FREEZE_JOB_DOMAIN);
}

function updateFreezeJob(input: Partial<WorkloadFreezeJob>): void {
  latestJob.patch(FREEZE_JOB_DOMAIN, input);
}

function periodProfile(
  records: WorkloadProfileRecord[],
  ranges: WorkloadTimeRange[],
): WorkloadProfileWindow | null {
  const starts = ranges.map((range) => Date.parse(range.from));
  const ends = ranges.map((range) => Date.parse(range.to));
  const fromMs = Math.min(...starts);
  const toMs = Math.max(...ends);
  if (fromMs >= toMs) {
    return null;
  }
  return describeWorkloadPeriod(records, fromMs, toMs);
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

function datasetRecord(input: {
  record: ReplayableWorkloadRecord;
  windowFromMs: number;
  previous: WorkloadRecord | null;
  write: WorkloadBlobSink;
}): WorkloadDatasetRecord {
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
  request: WorkloadDatasetFreezeRequest;
  plan: WorkloadSegmentPlanResult;
  signal: AbortSignal;
}): Promise<void> {
  const { request, plan, signal } = input;
  const staging = await stageWorkloadDataset();
  const pendingWrites: Array<Promise<void>> = [];
  const write: WorkloadBlobSink = (hash, json) => {
    pendingWrites.push(staging.writeBlob(hash, json));
  };
  let processedRecords = 0;
  const recordFrozen = async () => {
    processedRecords += 1;
    updateFreezeJob({ processedRecords });
    await yieldToEventLoop();
  };
  try {
    const segments: WorkloadDatasetSegment[] = [];
    for (const segmentPlan of plan.segments) {
      segments.push(
        await freezeSegment(segmentPlan, write, recordFrozen, signal),
      );
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
          listWorkloadProfileRecords({
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
    updateFreezeJob({ status: "succeeded", datasetId: id });
  } catch (error) {
    await Promise.allSettled(pendingWrites);
    await staging.discard();
    updateFreezeJob({
      status: signal.aborted ? "canceled" : "failed",
      error: signal.aborted ? "canceled" : errorMessage(error),
    });
  } finally {
    updateFreezeJob({ finishedAt: new Date().toISOString() });
  }
}

async function freezeSegment(
  segmentPlan: WorkloadSegmentPlan,
  write: WorkloadBlobSink,
  recordFrozen: () => Promise<void>,
  signal: AbortSignal,
): Promise<WorkloadDatasetSegment> {
  const windowFromMs = Date.parse(segmentPlan.window.from);
  const priming = segmentPlan.priming
    ? datasetRecord({
        record: segmentPlan.priming,
        windowFromMs,
        previous: null,
        write,
      })
    : null;
  if (priming) {
    await recordFrozen();
  }
  const records: WorkloadDatasetRecord[] = [];
  let previous: WorkloadRecord | null = null;
  for (const record of segmentPlan.records) {
    if (signal.aborted) {
      throw new Error("canceled");
    }
    records.push(datasetRecord({ record, windowFromMs, previous, write }));
    previous = record;
    await recordFrozen();
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
  const job = latestJob.start(FREEZE_JOB_DOMAIN, {
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
  });
  const controller = new AbortController();
  const completion = runFreeze({
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
  return job;
}

export async function waitForWorkloadFreeze(): Promise<void> {
  await getActiveJob(FREEZE_JOB_DOMAIN)?.completion;
}
