import type {
  WorkloadRecord,
  WorkloadSegmentSummary,
  WorkloadTimeRange,
} from "@arriero/core";

export type WorkloadSegmentPlan = {
  sessionId: string;
  windowIndex: number;
  window: WorkloadTimeRange;
  sourceName: string | null;
  modelId: string;
  priming: WorkloadRecord | null;
  records: WorkloadRecord[];
};

export type WorkloadSegmentPlanResult = {
  segments: WorkloadSegmentPlan[];
  problems: string[];
  warnings: string[];
};

const MAX_ANCESTOR_STEPS = 10_000;

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function replayable(record: WorkloadRecord): boolean {
  return (
    record.issue === null &&
    (record.outcome === "success" || record.outcome === "client-abort")
  );
}

function windowLabel(index: number, window: WorkloadTimeRange): string {
  return `window ${index + 1} (${window.from} – ${window.to})`;
}

function primingRecord(
  first: WorkloadRecord,
  lookup: (traceId: string) => WorkloadRecord | null,
): { record: WorkloadRecord | null; missing: boolean } {
  let parentId = first.parentTraceId;
  for (
    let step = 0;
    parentId !== null && step < MAX_ANCESTOR_STEPS;
    step += 1
  ) {
    const parent = lookup(parentId);
    if (!parent) {
      return { record: null, missing: true };
    }
    if (replayable(parent)) {
      return { record: parent, missing: false };
    }
    parentId = parent.parentTraceId;
  }
  return { record: null, missing: false };
}

export function planWorkloadSegments(input: {
  windows: WorkloadTimeRange[];
  recordsByWindow: WorkloadRecord[][];
  lookup: (traceId: string) => WorkloadRecord | null;
}): WorkloadSegmentPlanResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const segments: WorkloadSegmentPlan[] = [];
  const seenSessions = new Map<string, number>();

  input.windows.forEach((window, windowIndex) => {
    const fromMs = Date.parse(window.from);
    const toMs = Date.parse(window.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      problems.push(`${windowLabel(windowIndex, window)} is not a valid range`);
      return;
    }
    const starting = (input.recordsByWindow[windowIndex] ?? []).filter(
      (record) => {
        const at = Date.parse(record.at);
        return at >= fromMs && at < toMs;
      },
    );
    const failed = starting.filter((record) => record.outcome === "error");
    if (failed.length > 0) {
      problems.push(
        `${windowLabel(windowIndex, window)} has ${countLabel(failed.length, "failed request")}`,
      );
    }
    const unusable = starting.filter(
      (record) =>
        record.issue !== null &&
        (record.outcome === "success" || record.outcome === "client-abort"),
    );
    if (unusable.length > 0) {
      const kinds = [...new Set(unusable.map((record) => record.issue))].join(
        ", ",
      );
      problems.push(
        `${windowLabel(windowIndex, window)} has ${countLabel(unusable.length, "request")} that cannot be replayed (${kinds})`,
      );
    }
    const bySession = new Map<string, WorkloadRecord[]>();
    for (const record of starting) {
      if (!replayable(record)) {
        continue;
      }
      const list = bySession.get(record.sessionId) ?? [];
      list.push(record);
      bySession.set(record.sessionId, list);
    }
    for (const [sessionId, records] of bySession) {
      const earlier = seenSessions.get(sessionId);
      if (earlier !== undefined) {
        problems.push(
          `session ${sessionId} appears in windows ${earlier + 1} and ${windowIndex + 1}`,
        );
        continue;
      }
      seenSessions.set(sessionId, windowIndex);
      records.sort(
        (left, right) =>
          left.at.localeCompare(right.at) ||
          left.traceId.localeCompare(right.traceId),
      );
      const first = records[0];
      if (!first) {
        continue;
      }
      const priming = primingRecord(first, input.lookup);
      if (priming.missing) {
        warnings.push(
          `session ${sessionId}: the request before the window is no longer indexed, so its segment starts cold`,
        );
      }
      segments.push({
        sessionId,
        windowIndex,
        window,
        sourceName: first.sourceName,
        modelId: first.modelId,
        priming: priming.record,
        records,
      });
    }
  });

  if (segments.length === 0 && problems.length === 0) {
    problems.push("the selection contains no replayable request");
  }
  return { segments, problems, warnings };
}

export function summarizeWorkloadSegment(
  segment: WorkloadSegmentPlan,
): WorkloadSegmentSummary {
  const first = segment.records[0];
  let lastEndAt = first?.endAt ?? segment.window.from;
  let maxPromptTokens: number | null = null;
  for (const record of segment.records) {
    if (record.endAt > lastEndAt) {
      lastEndAt = record.endAt;
    }
    if (record.promptTokens !== null) {
      maxPromptTokens = Math.max(maxPromptTokens ?? 0, record.promptTokens);
    }
  }
  return {
    sessionId: segment.sessionId,
    windowIndex: segment.windowIndex,
    sourceName: segment.sourceName,
    modelId: segment.modelId,
    records: segment.records.length,
    primed: segment.priming !== null,
    firstAt: first?.at ?? segment.window.from,
    lastEndAt,
    maxPromptTokens,
  };
}
