import {
  engineDescriptor,
  type BenchmarkContextFit,
  type Instance,
  type WorkloadDatasetManifest,
  type WorkloadDatasetRecord,
} from "@arriero/core";

import { asObject, numberOrNull } from "../proxy/json.js";

export async function probeInstanceContextTokens(input: {
  instance: Instance;
  baseUrl: string;
  model: string | null;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<number | null> {
  if (engineDescriptor(input.instance.kind).nativeApi === "llama") {
    const query = input.model
      ? `?${new URLSearchParams({ model: input.model, autoload: "false" }).toString()}`
      : "";
    const response = await input.fetchImpl(`${input.baseUrl}/props${query}`, {
      signal: input.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const settings = asObject(
      asObject(await response.json())?.default_generation_settings,
    );
    return numberOrNull(settings?.n_ctx);
  }
  const response = await input.fetchImpl(`${input.baseUrl}/v1/models`, {
    signal: input.signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const data = asObject(await response.json())?.data;
  const entries = Array.isArray(data) ? data.map(asObject) : [];
  const entry =
    entries.find((item) => item?.id === input.model) ?? entries[0] ?? null;
  return numberOrNull(entry?.max_model_len);
}

function largestRecord(
  records: WorkloadDatasetRecord[],
): WorkloadDatasetRecord | null {
  let largest: WorkloadDatasetRecord | null = null;
  for (const record of records) {
    if (
      !largest ||
      (record.promptTokens ?? -1) > (largest.promptTokens ?? -1) ||
      (record.promptTokens === largest.promptTokens &&
        record.body.messages.length > largest.body.messages.length)
    ) {
      largest = record;
    }
  }
  return largest;
}

export async function checkDatasetContextFit(input: {
  manifest: WorkloadDatasetManifest;
  contextTokens: number | null;
  outputCeiling: number;
  countTokens: (record: WorkloadDatasetRecord) => Promise<number | null>;
}): Promise<BenchmarkContextFit> {
  const warnings: string[] = [];
  const segments: BenchmarkContextFit["segments"] = [];
  if (input.contextTokens === null) {
    warnings.push("the instance does not report its context size");
  }
  let uncounted = 0;
  for (const segment of input.manifest.content.segments) {
    const candidates = segment.priming
      ? [segment.priming, ...segment.records]
      : segment.records;
    const record = largestRecord(candidates);
    if (!record) {
      continue;
    }
    const promptTokens = await input.countTokens(record);
    if (promptTokens === null) {
      uncounted += 1;
    }
    segments.push({
      sessionId: segment.sessionId,
      traceId: record.traceId,
      promptTokens,
      fits:
        promptTokens === null || input.contextTokens === null
          ? null
          : promptTokens + input.outputCeiling <= input.contextTokens,
    });
  }
  if (uncounted > 0) {
    warnings.push(
      `${uncounted} of ${segments.length} segments could not be counted with the instance tokenizer`,
    );
  }
  return {
    contextTokens: input.contextTokens,
    outputCeiling: input.outputCeiling,
    segments,
    warnings,
  };
}
