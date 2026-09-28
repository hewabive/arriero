import { createHash } from "node:crypto";

import type {
  WorkloadDatasetBody,
  WorkloadDatasetContent,
  WorkloadDatasetRecord,
  WorkloadDatasetSegment,
} from "@arriero/core";

import { canonicalJsonDigest } from "../utils/canonical-json.js";
import {
  splitWorkloadChatBody,
  workloadThinkTimeMs,
  type ReplayableWorkloadRecord,
} from "./record-analysis.js";

export type WorkloadBlobSink = (hash: string, json: string) => void;

export function workloadBlobHash(json: string): string {
  return createHash("sha256").update(json).digest("hex");
}

export function encodeWorkloadBlob(value: unknown): {
  hash: string;
  json: string;
} {
  const json = JSON.stringify(value) ?? "null";
  return { hash: workloadBlobHash(json), json };
}

function putBlob(sink: WorkloadBlobSink, value: unknown): string {
  const { hash, json } = encodeWorkloadBlob(value);
  sink(hash, json);
  return hash;
}

export function decomposeWorkloadBody(
  protocol: "openai" | "anthropic",
  body: unknown,
  sink: WorkloadBlobSink,
): WorkloadDatasetBody | null {
  const parts = splitWorkloadChatBody(protocol, body);
  if (!parts) {
    return null;
  }
  return {
    fields: parts.fields,
    messages: parts.messages.map((message) => putBlob(sink, message)),
    tools: parts.tools === undefined ? null : putBlob(sink, parts.tools),
    system: parts.system === undefined ? null : putBlob(sink, parts.system),
  };
}

export function rebuildWorkloadBody(
  body: WorkloadDatasetBody,
  readBlob: (hash: string) => unknown,
): Record<string, unknown> {
  return {
    ...body.fields,
    messages: body.messages.map(readBlob),
    ...(body.tools !== null ? { tools: readBlob(body.tools) } : {}),
    ...(body.system !== null ? { system: readBlob(body.system) } : {}),
  };
}

function workloadBodyBlobHashes(body: WorkloadDatasetBody): string[] {
  return [
    ...body.messages,
    ...(body.tools !== null ? [body.tools] : []),
    ...(body.system !== null ? [body.system] : []),
  ];
}

export function workloadSegmentRecords(
  segment: WorkloadDatasetSegment,
): WorkloadDatasetRecord[] {
  return segment.priming
    ? [segment.priming, ...segment.records]
    : segment.records;
}

export function workloadContentBlobHashes(
  content: WorkloadDatasetContent,
): string[] {
  const hashes = new Set<string>();
  for (const segment of content.segments) {
    for (const record of workloadSegmentRecords(segment)) {
      for (const hash of workloadBodyBlobHashes(record.body)) {
        hashes.add(hash);
      }
    }
  }
  return [...hashes];
}

export function workloadDatasetId(content: WorkloadDatasetContent): string {
  return canonicalJsonDigest(content);
}

export function workloadDatasetRecord(input: {
  record: ReplayableWorkloadRecord;
  captured: {
    protocol: "openai" | "anthropic";
    endpoint: string;
    routePath: string;
  };
  body: WorkloadDatasetBody;
  windowFromMs: number;
  previous: { endAt: string } | null;
}): WorkloadDatasetRecord {
  const at = Date.parse(input.record.at);
  return {
    traceId: input.record.traceId,
    protocol: input.captured.protocol,
    endpoint: input.captured.endpoint,
    routePath: input.captured.routePath,
    offsetMs: Math.max(0, Math.round(at - input.windowFromMs)),
    thinkTimeMs: workloadThinkTimeMs(input.previous, input.record.at),
    durationMs: input.record.durationMs,
    outcome: input.record.outcome,
    targetName: input.record.targetName,
    promptTokens: input.record.promptTokens,
    cacheReadTokens: input.record.cacheReadTokens,
    completionTokens: input.record.completionTokens,
    ttftMs: input.record.ttftMs,
    body: input.body,
  };
}
