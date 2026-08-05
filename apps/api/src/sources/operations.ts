import {
  SourceRepositoryCloneSchema,
  SourceRepositoryOperationResultSchema,
  SourceRepositorySettingsUpdateSchema,
  type SourceRepositoryClone,
  type SourceRepositoryOperationPhase,
  type SourceRepositoryOperationResult,
  type SourceRepositorySettingsUpdate,
} from "@arriero/core";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { buildRunner } from "../build/runner.js";
import { config } from "../config.js";
import { getActiveConfigGitOperation } from "../config-git/state.js";
import {
  assertGitRemoteUrl,
  gitOutput,
  runGit,
  tryGit,
} from "../git/process.js";
import {
  getSourceRepositoryDefinition,
  LLAMA_CPP_SOURCE_ID,
  listSourceRepositoryDefinitions,
} from "./registry.js";
import {
  assertSourceRepositoryReady,
  getSourceRepositorySpec,
  getSourceRepositoryStatus,
  saveSourceRepositoryOrigin,
  sourceRepositoryPath,
} from "./repository.js";
import { withSourceRepositoryOperation } from "./state.js";

const CLONE_STAGING_PREFIX = ".source-clone-";

export type SourceRepositoryOperationRuntime = {
  signal?: AbortSignal;
  onGitOutput?: (target: "stdout" | "stderr", chunk: string) => void;
  onPhase?: (input: {
    phase: SourceRepositoryOperationPhase;
    message: string;
  }) => void;
};

function assertOperationNotCanceled(
  runtime: SourceRepositoryOperationRuntime,
): void {
  if (runtime.signal?.aborted) {
    throw new Error("source repository operation canceled");
  }
}

export function sweepSourceCloneStaging(): number {
  const parents = new Set<string>([config.sourcesDir]);
  for (const definition of listSourceRepositoryDefinitions()) {
    parents.add(dirname(sourceRepositoryPath(definition.id)));
  }
  let removed = 0;
  for (const parent of parents) {
    let names: string[];
    try {
      names = readdirSync(parent);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(CLONE_STAGING_PREFIX)) continue;
      rmSync(resolve(parent, name), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

export function assertSourceContentCanChange(sourceId: string) {
  if (sourceId === LLAMA_CPP_SOURCE_ID && buildRunner.isRunning()) {
    throw new Error(
      "cannot change a source repository while a build is running",
    );
  }
  const configOperation = getActiveConfigGitOperation();
  if (configOperation) {
    throw new Error(
      `cannot change a source repository while configuration Git operation is running: ${configOperation}`,
    );
  }
}

async function validateClonedRepository(sourceId: string, repoPath: string) {
  const topLevel = (
    await runGit(repoPath, ["rev-parse", "--show-toplevel"])
  ).stdout.trim();
  if (realpathSync(topLevel) !== realpathSync(repoPath)) {
    throw new Error(
      `cloned repository root is ${topLevel}, expected ${repoPath}`,
    );
  }
  const checkoutError =
    getSourceRepositoryDefinition(sourceId).validateCheckout(repoPath);
  if (checkoutError) {
    throw new Error(checkoutError);
  }
}

async function result(
  sourceId: string,
  operation: string,
  output: string,
): Promise<SourceRepositoryOperationResult> {
  return SourceRepositoryOperationResultSchema.parse({
    operation,
    output,
    status: await getSourceRepositoryStatus(sourceId),
  });
}

export async function cloneSourceRepository(
  sourceId: string,
  input: SourceRepositoryClone,
  runtime: SourceRepositoryOperationRuntime = {},
): Promise<SourceRepositoryOperationResult> {
  const parsed = SourceRepositoryCloneSchema.parse(input);
  const current = getSourceRepositorySpec(sourceId);
  const originUrl = parsed.originUrl ?? current.originUrl;
  assertGitRemoteUrl(originUrl, { allowFile: true, allowHttp: true });
  if (parsed.branch?.startsWith("-")) {
    throw new Error("invalid branch name");
  }
  assertSourceContentCanChange(sourceId);

  const output = await withSourceRepositoryOperation(
    sourceId,
    "clone",
    async () => {
      assertOperationNotCanceled(runtime);
      const target = sourceRepositoryPath(current);
      if (existsSync(target)) {
        throw new Error(`repository path already exists: ${target}`);
      }
      const parent = dirname(target);
      mkdirSync(parent, { recursive: true });
      const temporary = mkdtempSync(resolve(parent, CLONE_STAGING_PREFIX));
      const staging = resolve(temporary, "repository");
      runtime.onPhase?.({
        phase: "starting",
        message: `Starting full clone from ${originUrl}.`,
      });
      const args = ["clone", "--progress", "--origin", "origin"];
      if (parsed.branch) args.push("--branch", parsed.branch);
      args.push("--", originUrl, staging);
      try {
        const cloned = await runGit(parent, args, {
          timeoutMs: 30 * 60_000,
          maxOutputBytes: 8 * 1024 * 1024,
          ...(runtime.signal ? { signal: runtime.signal } : {}),
          ...(runtime.onGitOutput ? { onOutput: runtime.onGitOutput } : {}),
          killProcessGroup: true,
        });
        assertOperationNotCanceled(runtime);
        runtime.onPhase?.({
          phase: "validating",
          message: "Validating the cloned checkout.",
        });
        await validateClonedRepository(sourceId, staging);
        assertOperationNotCanceled(runtime);
        runtime.onPhase?.({
          phase: "publishing",
          message: `Publishing the checkout to ${target}.`,
        });
        renameSync(staging, target);
        saveSourceRepositoryOrigin(sourceId, originUrl);
        return gitOutput(cloned) || `Cloned ${originUrl}.`;
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    },
  );
  return result(sourceId, "clone", output);
}

export async function updateSourceRepositorySettings(
  sourceId: string,
  input: SourceRepositorySettingsUpdate,
): Promise<SourceRepositoryOperationResult> {
  const parsed = SourceRepositorySettingsUpdateSchema.parse(input);
  assertGitRemoteUrl(parsed.originUrl, { allowFile: true, allowHttp: true });
  assertSourceContentCanChange(sourceId);

  const output = await withSourceRepositoryOperation(
    sourceId,
    "set-origin",
    async () => {
      const status = await getSourceRepositoryStatus(sourceId);
      if (!status.exists) {
        saveSourceRepositoryOrigin(sourceId, parsed.originUrl);
        return "Saved origin for the next clone.";
      }
      if (!status.valid) {
        throw new Error(
          status.error ?? `source repository ${sourceId} is not ready`,
        );
      }
      const existing = await tryGit(status.repoPath, [
        "remote",
        "get-url",
        "origin",
      ]);
      const changed = existing
        ? await runGit(status.repoPath, [
            "remote",
            "set-url",
            "origin",
            parsed.originUrl,
          ])
        : await runGit(status.repoPath, [
            "remote",
            "add",
            "origin",
            parsed.originUrl,
          ]);
      saveSourceRepositoryOrigin(sourceId, parsed.originUrl);
      return gitOutput(changed) || `Origin set to ${parsed.originUrl}.`;
    },
  );
  return result(sourceId, "set-origin", output);
}

export async function pullSourceRepository(
  sourceId: string,
  runtime: SourceRepositoryOperationRuntime = {},
): Promise<SourceRepositoryOperationResult> {
  assertSourceContentCanChange(sourceId);
  const output = await withSourceRepositoryOperation(
    sourceId,
    "pull",
    async () => {
      assertOperationNotCanceled(runtime);
      const status = await assertSourceRepositoryReady(sourceId);
      runtime.onPhase?.({
        phase: "updating",
        message: "Fetching and fast-forwarding the tracking branch.",
      });
      const pulled = await runGit(
        status.repoPath,
        ["pull", "--progress", "--ff-only"],
        {
          timeoutMs: 10 * 60_000,
          maxOutputBytes: 8 * 1024 * 1024,
          ...(runtime.signal ? { signal: runtime.signal } : {}),
          ...(runtime.onGitOutput ? { onOutput: runtime.onGitOutput } : {}),
          killProcessGroup: true,
        },
      );
      return gitOutput(pulled) || "Already up to date.";
    },
  );
  return result(sourceId, "pull", output);
}
