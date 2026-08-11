import {
  EngineArgumentExtractSchema,
  type EngineArgumentDeclaration,
  type EngineArgumentExtract,
} from "@arriero/core";

import { canonicalJsonDigest } from "../utils/canonical-json.js";

export type ParsedExtract =
  | { extract: EngineArgumentExtract; error: null }
  | { extract: null; error: string };

export function parseEngineArgumentExtract(payload: string): ParsedExtract {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch (error) {
    return {
      extract: null,
      error: `extract is not valid JSON: ${(error as Error).message}`,
    };
  }
  const parsed = EngineArgumentExtractSchema.safeParse(json);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    return {
      extract: null,
      error:
        `extract does not match the schema: ${issue?.path.join(".") ?? "?"} ${issue?.message ?? ""}`.trim(),
    };
  }
  return { extract: parsed.data, error: null };
}

function surfaceOf(option: EngineArgumentDeclaration) {
  return {
    flags: option.flags,
    group: option.group,
    help: option.help,
    choices: option.choices,
    optional: option.optional ?? false,
    default: option.default,
    action: option.action,
    hidden: option.hidden,
  };
}

export function engineArgumentSurfaceHash(extract: EngineArgumentExtract) {
  return canonicalJsonDigest({
    engine: extract.engine,
    entrypoint: extract.entrypoint,
    options: extract.options.map(surfaceOf),
  });
}

export function normalizeHelpPayload(payload: string) {
  return `${payload.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd()}\n`;
}

export function nowIso() {
  return new Date().toISOString();
}

function byPrimaryFlag(extract: EngineArgumentExtract) {
  return new Map(extract.options.map((option) => [option.flags[0]!, option]));
}

function valueText(value: unknown) {
  if (value === null || value === undefined) {
    return "none";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => String(item)).join(", ")}]`;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function shorten(value: string, limit = 140) {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

function commonPrefixLength(left: string, right: string) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(left: string, right: string, prefix: number) {
  const limit = Math.min(left.length, right.length) - prefix;
  let index = 0;
  while (
    index < limit &&
    left[left.length - 1 - index] === right[right.length - 1 - index]
  ) {
    index += 1;
  }
  return index;
}

function changedTextFragments(leftValue: string, rightValue: string) {
  const left = leftValue.replace(/\s+/g, " ").trim();
  const right = rightValue.replace(/\s+/g, " ").trim();
  const prefix = commonPrefixLength(left, right);
  const suffix = commonSuffixLength(left, right, prefix);
  const context = 24;
  const lead =
    prefix > context
      ? `…${left.slice(prefix - context, prefix)}`
      : left.slice(0, prefix);
  const tail =
    suffix > context
      ? `${left.slice(left.length - suffix, left.length - suffix + context)}…`
      : left.slice(left.length - suffix);

  const fragment = (value: string) =>
    `${lead}[${shorten(value.slice(prefix, value.length - suffix), 120)}]${tail}`;

  return { left: fragment(left), right: fragment(right) };
}

export function diffEngineArgumentExtracts(
  stored: EngineArgumentExtract | null,
  current: EngineArgumentExtract,
) {
  if (!stored) {
    return [
      `${current.options.length} arguments in ${current.entrypoint}; no stored snapshot to compare against.`,
    ].join("\n");
  }

  const storedOptions = byPrimaryFlag(stored);
  const currentOptions = byPrimaryFlag(current);
  const lines: string[] = [];

  for (const [flag, option] of currentOptions) {
    const previous = storedOptions.get(flag);
    if (!previous) {
      lines.push(`+ ${flag}${option.group ? ` (${option.group})` : ""}`);
      if (option.help) {
        lines.push(`    help: ${shorten(option.help)}`);
      }
      continue;
    }
    const leftSurface = surfaceOf(previous) as Record<string, unknown>;
    const rightSurface = surfaceOf(option) as Record<string, unknown>;
    const fields = Object.keys(rightSurface).filter(
      (key) =>
        JSON.stringify(leftSurface[key]) !== JSON.stringify(rightSurface[key]),
    );
    if (fields.length === 0) {
      continue;
    }
    lines.push(`~ ${flag}`);
    for (const field of fields) {
      const left = leftSurface[field];
      const right = rightSurface[field];
      const bothLong =
        typeof left === "string" &&
        typeof right === "string" &&
        Math.max(left.length, right.length) > 160;
      if (bothLong) {
        const fragments = changedTextFragments(left, right);
        lines.push(`    ${field}: ${fragments.left} -> ${fragments.right}`);
        continue;
      }
      lines.push(
        `    ${field}: ${shorten(valueText(left))} -> ${shorten(valueText(right))}`,
      );
    }
  }

  for (const flag of storedOptions.keys()) {
    if (!currentOptions.has(flag)) {
      lines.push(`- ${flag}`);
    }
  }

  return lines.length > 0
    ? lines.join("\n")
    : "No argument declaration changes.";
}
