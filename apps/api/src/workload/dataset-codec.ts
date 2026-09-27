import { createHash } from "node:crypto";

import type {
  WorkloadDatasetBody,
  WorkloadDatasetContent,
  WorkloadDatasetRecord,
  WorkloadRecord,
} from "@arriero/core";

import { asObject } from "../proxy/json.js";
import { canonicalJsonDigest } from "../utils/canonical-json.js";

export type WorkloadBlobSink = (hash: string, json: string) => void;

export function workloadBlobHash(json: string): string {
  return createHash("sha256").update(json).digest("hex");
}

function putBlob(sink: WorkloadBlobSink, value: unknown): string {
  const json = JSON.stringify(value) ?? "null";
  const hash = workloadBlobHash(json);
  sink(hash, json);
  return hash;
}

export function decomposeWorkloadBody(
  protocol: "openai" | "anthropic",
  body: unknown,
  sink: WorkloadBlobSink,
): WorkloadDatasetBody | null {
  const record = asObject(body);
  const messages = record?.messages;
  if (!record || !Array.isArray(messages)) {
    return null;
  }
  const separateSystem = protocol === "anthropic";
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (
      key === "messages" ||
      key === "tools" ||
      (separateSystem && key === "system")
    ) {
      continue;
    }
    fields[key] = value;
  }
  return {
    fields,
    messages: messages.map((message) => putBlob(sink, message)),
    tools: record.tools === undefined ? null : putBlob(sink, record.tools),
    system:
      separateSystem && record.system !== undefined
        ? putBlob(sink, record.system)
        : null,
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

export function workloadContentBlobHashes(
  content: WorkloadDatasetContent,
): string[] {
  const hashes = new Set<string>();
  for (const segment of content.segments) {
    const records = segment.priming
      ? [segment.priming, ...segment.records]
      : segment.records;
    for (const record of records) {
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
  record: WorkloadRecord;
  captured: {
    protocol: "openai" | "anthropic";
    endpoint: string;
    routePath: string;
  };
  body: WorkloadDatasetBody;
  windowFromMs: number;
  previous: WorkloadRecord | null;
}): WorkloadDatasetRecord {
  const at = Date.parse(input.record.at);
  const previousEnd = input.previous
    ? Date.parse(input.previous.at) + input.previous.durationMs
    : null;
  return {
    traceId: input.record.traceId,
    protocol: input.captured.protocol,
    endpoint: input.captured.endpoint,
    routePath: input.captured.routePath,
    offsetMs: Math.max(0, Math.round(at - input.windowFromMs)),
    thinkTimeMs:
      previousEnd === null ? null : Math.max(0, Math.round(at - previousEnd)),
    durationMs: input.record.durationMs,
    outcome:
      input.record.outcome === "client-abort" ? "client-abort" : "success",
    targetName: input.record.targetName,
    promptTokens: input.record.promptTokens,
    cacheReadTokens: input.record.cacheReadTokens,
    completionTokens: input.record.completionTokens,
    ttftMs: input.record.ttftMs,
    body: input.body,
  };
}
