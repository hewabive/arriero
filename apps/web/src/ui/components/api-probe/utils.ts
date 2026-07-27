import type {
  ApiProbeKind,
  ApiProbeResult,
  EndpointProbe,
} from "@arriero/core";

import type { ModelOption } from "./types";

export function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function modelStatus(record: Record<string, unknown>) {
  const status = objectRecord(record.status);
  if (status?.failed === true) return "failed";
  return stringValue(status?.value);
}

export function modelOptionsFromProbe(
  probe: EndpointProbe | undefined,
): ModelOption[] {
  const body = objectRecord(probe?.body);
  const data = [...arrayValue(body?.data), ...arrayValue(body?.models)];
  const seen = new Set<string>();
  return data
    .map((item) => {
      const record = objectRecord(item);
      const id =
        stringValue(record?.id) ??
        stringValue(record?.name) ??
        stringValue(record?.model);
      if (!record || !id) return null;
      if (seen.has(id)) return null;
      seen.add(id);
      const status = modelStatus(record);
      return {
        value: id,
        label: status ? `${id} (${status})` : id,
        status,
      };
    })
    .filter((item): item is ModelOption => Boolean(item))
    .sort((left, right) =>
      left.value.localeCompare(right.value, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
}

function endpointErrorText(probe: EndpointProbe | undefined) {
  const error = objectRecord(probe?.body)?.error;
  const message = objectRecord(error)?.message;
  if (typeof message === "string" && message.trim()) {
    return message;
  }
  return probe?.error ?? null;
}

function formatNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat().format(Math.round(value * 100) / 100)
    : null;
}

export function formatUnknown(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function errorMessage(value: unknown) {
  if (value instanceof Error) return value.message;
  const record = objectRecord(value);
  const message =
    stringValue(record?.message) ??
    stringValue(objectRecord(record?.error)?.message);
  const fallback = formatUnknown(value);
  return message ?? (fallback || "Unknown error");
}

export function parseTokenInput(value: string) {
  return (value.match(/-?\d+/g) ?? [])
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item));
}

export function parseDocumentsInput(value: string) {
  return value
    .split(/\n\s*\n/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function responseOutput(result: ApiProbeResult) {
  const body = result.response.body;
  const record = objectRecord(body);

  if (!result.response.ok) {
    return endpointErrorText(result.response) ?? "Request failed";
  }

  if (result.kind === "tokenize") {
    const tokens = arrayValue(record?.tokens);
    const preview = tokens
      .slice(0, 64)
      .map((token) => {
        const tokenRecord = objectRecord(token);
        if (!tokenRecord) return String(token);
        const id = tokenRecord.id;
        const piece = tokenRecord.piece;
        return `${id}:${Array.isArray(piece) ? `[${piece.join(",")}]` : String(piece)}`;
      })
      .join("  ");
    return `${tokens.length} token${tokens.length === 1 ? "" : "s"}${preview ? `\n${preview}` : ""}`;
  }

  if (result.kind === "detokenize") {
    return stringValue(record?.content) ?? "Detokenize returned no content";
  }

  if (result.kind === "count-tokens") {
    const count = formatNumber(record?.input_tokens);
    return count ? `${count} input tokens` : "Count returned no input_tokens";
  }

  if (result.kind === "apply-template") {
    return stringValue(record?.prompt) ?? "Template returned no prompt field";
  }

  if (result.kind === "embeddings") {
    const data = arrayValue(record?.data);
    const first = objectRecord(data[0]);
    const dimensions = Array.isArray(first?.embedding)
      ? first.embedding.length
      : null;
    return `${data.length} embedding${data.length === 1 ? "" : "s"}${
      dimensions ? ` · ${dimensions} dimensions` : ""
    }`;
  }

  if (result.kind === "rerank") {
    const rows = arrayValue(record?.results)
      .map((item) => {
        const resultRecord = objectRecord(item);
        const score = resultRecord?.relevance_score ?? resultRecord?.score;
        return typeof resultRecord?.index === "number" &&
          typeof score === "number"
          ? `#${resultRecord.index}: ${score.toFixed(4)}`
          : null;
      })
      .filter(Boolean);
    return rows.length > 0 ? rows.join("\n") : "Rerank returned no result rows";
  }

  if (result.kind === "infill") {
    return stringValue(record?.content) ?? "Infill returned no content";
  }

  if (result.kind === "responses") {
    const outputText = stringValue(record?.output_text);
    if (outputText) return outputText;
    const output = arrayValue(record?.output);
    return (
      output
        .flatMap((item) => arrayValue(objectRecord(item)?.content))
        .map((content) => stringValue(objectRecord(content)?.text))
        .filter(Boolean)
        .join("\n\n") || "Response returned no text output"
    );
  }

  const firstChoice = objectRecord(arrayValue(record?.choices)[0]);
  if (result.kind === "chat") {
    return (
      stringValue(objectRecord(firstChoice?.message)?.content) ??
      stringValue(objectRecord(firstChoice?.message)?.reasoning_content) ??
      stringValue(firstChoice?.text) ??
      "Chat response returned no message content"
    );
  }

  return stringValue(firstChoice?.text) ?? "Completion returned no text";
}

export function kindNeedsGenerationControls(kind: ApiProbeKind) {
  return (
    kind === "chat" ||
    kind === "completion" ||
    kind === "responses" ||
    kind === "infill"
  );
}

export function kindSupportsSystemPrompt(kind: ApiProbeKind) {
  return (
    kind === "chat" ||
    kind === "responses" ||
    kind === "apply-template" ||
    kind === "count-tokens"
  );
}

export function kindUsesPrompt(kind: ApiProbeKind) {
  return kind !== "detokenize";
}

export function promptLabel(kind: ApiProbeKind) {
  if (kind === "tokenize") return "Text";
  if (kind === "embeddings") return "Input";
  if (kind === "rerank") return "Query";
  if (kind === "infill") return "Middle prompt";
  return "Prompt";
}
