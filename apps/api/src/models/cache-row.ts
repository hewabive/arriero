import { logger } from "../logger.js";

export function parseCacheJson<T>(
  value: string,
  path: string,
  field: string,
  label: string,
): T | null {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    logger.warn(
      { err: error, path, field },
      `${label} cache row could not be parsed`,
    );
    return null;
  }
}

type DerivableCacheRow = {
  path: string;
  rawVersion: number;
  parserVersion: number;
  metadataJson: string;
};

export function deriveCacheRowMetadata<TFacts, TMetadata>(input: {
  row: DerivableCacheRow;
  rawJson: () => string | null;
  rawVersion: number;
  parserVersion: number;
  label: string;
  derive: (facts: TFacts) => TMetadata;
}): {
  facts: () => TFacts | null;
  metadata: TMetadata | null;
  derivedCurrent: boolean;
} {
  let factsMemo: TFacts | null | undefined;
  const facts = () => {
    if (factsMemo !== undefined) {
      return factsMemo;
    }
    if (input.row.rawVersion !== input.rawVersion) {
      factsMemo = null;
      return factsMemo;
    }
    const raw = input.rawJson();
    factsMemo = raw
      ? parseCacheJson<TFacts>(raw, input.row.path, "raw_json", input.label)
      : null;
    return factsMemo;
  };
  if (input.row.parserVersion === input.parserVersion) {
    const stored = parseCacheJson<TMetadata>(
      input.row.metadataJson,
      input.row.path,
      "metadata_json",
      input.label,
    );
    if (stored) {
      return { facts, metadata: stored, derivedCurrent: true };
    }
  }
  const loaded = facts();
  return {
    facts,
    metadata: loaded ? input.derive(loaded) : null,
    derivedCurrent: false,
  };
}
