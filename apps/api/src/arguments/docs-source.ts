import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

import type { LlamaArgumentHelpSourceSync } from "@arriero/core";

import { config } from "../config.js";
import {
  getLlamaSourceCurrentCommit,
  getLlamaSourceSettings,
  llamaSourceCommitIsReachable,
} from "../llama/source-repository.js";
import { normalizeHelpPayload, nowIso } from "./help-source.js";

const helpStartMarker = "<!-- HELP_START -->";
const helpEndMarker = "<!-- HELP_END -->";
const helpBlockName = "HELP_START..HELP_END";
const sourceRelativePath = "tools/server/README.md";

const argumentHelpSourceDirectory = resolve(
  config.rootDir,
  "content",
  "llama-args",
  "source",
);
const argumentHelpSourceSnapshotPath = resolve(
  argumentHelpSourceDirectory,
  "server-help.generated.md",
);
const argumentHelpSourceMetadataPath = resolve(
  argumentHelpSourceDirectory,
  "help-source.json",
);

type HelpSourceMetadata = {
  schema: 1;
  source: string;
  block: string;
  hash: string;
  llamaCppCommit: string | null;
  updatedAt: string;
};

function hashHelpBlock(block: string) {
  return createHash("sha256").update(block).digest("hex");
}

export function extractGeneratedHelpBlock(readme: string) {
  const normalized = readme.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const start = normalized.indexOf(helpStartMarker);
  const endStart = normalized.indexOf(
    helpEndMarker,
    start + helpStartMarker.length,
  );

  if (start === -1 || endStart === -1 || endStart <= start) {
    throw new Error(
      `Generated help block markers not found: ${helpStartMarker} / ${helpEndMarker}`,
    );
  }

  return normalizeHelpPayload(
    normalized.slice(start, endStart + helpEndMarker.length),
  );
}

function sourceReadmePath() {
  return resolve(getLlamaSourceSettings().repoPath, sourceRelativePath);
}

const argParserRelativePath = "common/arg.cpp";

export function helpBlockFlagRows(block: string) {
  const rows: { label: string; flags: string[] }[] = [];
  for (const line of block.split("\n")) {
    if (!line.startsWith("|")) {
      continue;
    }
    const cellEnd = line.indexOf("|", 1);
    if (cellEnd === -1) {
      continue;
    }
    const cell = line.slice(1, cellEnd).trim();
    if (!cell.startsWith("`")) {
      continue;
    }
    const label = cell.replace(/^`|`$/g, "").trim();
    const flags = label
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0] ?? "")
      .filter((token) => token.startsWith("-"));
    if (flags.length > 0) {
      rows.push({ label, flags });
    }
  }
  return rows;
}

export function phantomHelpRows(block: string, argParserSource: string) {
  const quotedFlags = new Set(
    [...argParserSource.matchAll(/"(-[^"]*)"/g)].map((match) => match[1]),
  );
  return helpBlockFlagRows(block)
    .filter((row) => !row.flags.some((flag) => quotedFlags.has(flag)))
    .map((row) => row.label);
}

function currentPhantomRows(block: string): string[] | null {
  const argParserPath = resolve(
    getLlamaSourceSettings().repoPath,
    argParserRelativePath,
  );
  if (!existsSync(argParserPath)) {
    return null;
  }
  try {
    return phantomHelpRows(block, readFileSync(argParserPath, "utf8"));
  } catch {
    return null;
  }
}

function readMetadata(): HelpSourceMetadata | null {
  if (!existsSync(argumentHelpSourceMetadataPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      readFileSync(argumentHelpSourceMetadataPath, "utf8"),
    ) as Partial<HelpSourceMetadata>;
    if (
      parsed.schema !== 1 ||
      parsed.source !== sourceRelativePath ||
      parsed.block !== helpBlockName ||
      typeof parsed.hash !== "string"
    ) {
      return null;
    }
    return {
      schema: 1,
      source: sourceRelativePath,
      block: helpBlockName,
      hash: parsed.hash,
      llamaCppCommit:
        typeof parsed.llamaCppCommit === "string"
          ? parsed.llamaCppCommit
          : null,
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
    };
  } catch {
    return null;
  }
}

function readStoredGeneratedHelpBlock() {
  if (!existsSync(argumentHelpSourceSnapshotPath)) {
    return null;
  }
  return normalizeHelpPayload(
    readFileSync(argumentHelpSourceSnapshotPath, "utf8"),
  );
}

function readCurrentGeneratedHelpBlock() {
  const path = sourceReadmePath();
  if (!existsSync(path)) {
    throw new Error(`llama.cpp server README not found: ${path}`);
  }
  return extractGeneratedHelpBlock(readFileSync(path, "utf8"));
}

function storedSnapshot(currentCommit: string | null) {
  const metadata = readMetadata();
  const block = readStoredGeneratedHelpBlock();
  if (!block) {
    return {
      path: argumentHelpSourceSnapshotPath,
      exists: false,
      hash: metadata?.hash ?? null,
      llamaCppCommit: metadata?.llamaCppCommit ?? null,
      updatedAt: metadata?.updatedAt ?? null,
      error: "stored generated help snapshot not found",
    };
  }

  const computedHash = hashHelpBlock(block);
  return {
    path: argumentHelpSourceSnapshotPath,
    exists: true,
    hash: metadata?.hash ?? computedHash,
    llamaCppCommit: metadata?.llamaCppCommit ?? null,
    updatedAt:
      metadata?.updatedAt ??
      statSync(argumentHelpSourceSnapshotPath).mtime.toISOString(),
    error: storedSnapshotError(metadata, computedHash, currentCommit),
  };
}

function storedSnapshotError(
  metadata: HelpSourceMetadata | null,
  computedHash: string,
  currentCommit: string | null,
) {
  if (metadata && metadata.hash !== computedHash) {
    return `metadata hash ${metadata.hash} does not match snapshot hash ${computedHash}`;
  }
  if (
    metadata?.llamaCppCommit &&
    llamaSourceCommitIsReachable(metadata.llamaCppCommit, currentCommit) ===
      false
  ) {
    return `snapshot commit ${metadata.llamaCppCommit.slice(0, 9)} is not reachable from the llama.cpp checkout HEAD — the snapshot was not written from this checkout`;
  }
  return null;
}

type CurrentHelpBlock =
  | { block: string; error: null }
  | { block: null; error: string };

function readCurrentHelpBlockSafe(): CurrentHelpBlock {
  try {
    return { block: readCurrentGeneratedHelpBlock(), error: null };
  } catch (error) {
    return { block: null, error: (error as Error).message };
  }
}

function currentSnapshot(
  read: CurrentHelpBlock,
  llamaCppCommit: string | null,
) {
  const path = sourceReadmePath();
  if (read.block === null) {
    return {
      path,
      exists: existsSync(path),
      hash: null,
      llamaCppCommit,
      updatedAt: existsSync(path) ? statSync(path).mtime.toISOString() : null,
      error: read.error,
    };
  }
  return {
    path,
    exists: true,
    hash: hashHelpBlock(read.block),
    llamaCppCommit,
    updatedAt: statSync(path).mtime.toISOString(),
    error: null,
  };
}

export function getLlamaArgumentHelpSourceSync(): LlamaArgumentHelpSourceSync {
  const llamaCppCommit = getLlamaSourceCurrentCommit();
  const read = readCurrentHelpBlockSafe();
  const stored = storedSnapshot(llamaCppCommit);
  const current = currentSnapshot(read, llamaCppCommit);
  const inSync =
    stored.hash && current.hash && !stored.error && !current.error
      ? stored.hash === current.hash
      : null;

  return {
    sourcePath: sourceRelativePath,
    block: helpBlockName,
    snapshotPath: argumentHelpSourceSnapshotPath,
    metadataPath: argumentHelpSourceMetadataPath,
    stored,
    current,
    inSync,
    phantomRows: read.block === null ? null : currentPhantomRows(read.block),
  };
}

export function updateStoredGeneratedHelpSnapshot() {
  const block = readCurrentGeneratedHelpBlock();
  const hash = hashHelpBlock(block);
  const metadata: HelpSourceMetadata = {
    schema: 1,
    source: sourceRelativePath,
    block: helpBlockName,
    hash,
    llamaCppCommit: getLlamaSourceCurrentCommit(),
    updatedAt: nowIso(),
  };

  mkdirSync(dirname(argumentHelpSourceSnapshotPath), { recursive: true });
  writeFileSync(argumentHelpSourceSnapshotPath, block, "utf8");
  writeFileSync(
    argumentHelpSourceMetadataPath,
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
  return getLlamaArgumentHelpSourceSync();
}

type DiffOp = { kind: "equal" | "remove" | "add"; line: string };

function diffLines(left: string[], right: string[]): DiffOp[] {
  const lengths = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  );

  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i]![j] =
        left[i] === right[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      ops.push({ kind: "equal", line: left[i]! });
      i += 1;
      j += 1;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      ops.push({ kind: "remove", line: left[i]! });
      i += 1;
    } else {
      ops.push({ kind: "add", line: right[j]! });
      j += 1;
    }
  }
  while (i < left.length) {
    ops.push({ kind: "remove", line: left[i]! });
    i += 1;
  }
  while (j < right.length) {
    ops.push({ kind: "add", line: right[j]! });
    j += 1;
  }
  return ops;
}

function label(path: string) {
  return relative(config.rootDir, path) || path;
}

export function generatedHelpDiff() {
  const stored = readStoredGeneratedHelpBlock() ?? "";
  const current = readCurrentGeneratedHelpBlock();
  const ops = diffLines(stored.split("\n"), current.split("\n"));
  const body = ops
    .filter((op, index, all) => {
      if (op.kind !== "equal") return true;
      const hasChangeNearby = all
        .slice(Math.max(0, index - 3), Math.min(all.length, index + 4))
        .some((near) => near.kind !== "equal");
      return hasChangeNearby;
    })
    .map((op) => {
      if (op.kind === "add") return `+${op.line}`;
      if (op.kind === "remove") return `-${op.line}`;
      return ` ${op.line}`;
    })
    .join("\n");

  return [
    `--- ${label(argumentHelpSourceSnapshotPath)}`,
    `+++ ${label(sourceReadmePath())}`,
    body || "No generated help block changes.",
  ].join("\n");
}

export function generatedHelpChangedLines() {
  const stored = readStoredGeneratedHelpBlock() ?? "";
  const current = readCurrentGeneratedHelpBlock();
  return diffLines(stored.split("\n"), current.split("\n"))
    .filter((op) => op.kind !== "equal")
    .map((op) => (op.kind === "add" ? `+${op.line}` : `-${op.line}`))
    .join("\n");
}
