import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { config } from "../config.js";
import { resolveExecutable } from "../system/tool-probe.js";

const execFileAsync = promisify(execFile);

type ExtractorRun =
  | { payload: string; error: null }
  | { payload: null; error: string };

function extractorScriptPath(script: string) {
  return resolve(config.rootDir, "scripts", "extract-args", script);
}

export type ExtractorRunner = (input: {
  script: string;
  repoPath: string;
  timeoutMs?: number;
}) => Promise<ExtractorRun>;

export const runArgumentExtractor: ExtractorRunner = async (input) => {
  const scriptPath = extractorScriptPath(input.script);
  if (!existsSync(scriptPath)) {
    return { payload: null, error: `extractor not found: ${scriptPath}` };
  }
  if (!existsSync(input.repoPath)) {
    return {
      payload: null,
      error: `engine checkout not found: ${input.repoPath}`,
    };
  }

  const python = resolveExecutable("python3", process.env);
  if (!python) {
    return {
      payload: null,
      error:
        "python3 not found in PATH; the argument declaration cannot be extracted on this host",
    };
  }

  try {
    const { stdout } = await execFileAsync(
      python,
      [scriptPath, "--repo", input.repoPath, "--out", "-"],
      {
        encoding: "utf8",
        timeout: input.timeoutMs ?? 60_000,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    return { payload: stdout, error: null };
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    const detail = (failure.stderr ?? failure.message ?? "").trim();
    const lastLine =
      detail.split("\n").filter(Boolean).at(-1) ?? "unknown error";
    return { payload: null, error: `extractor failed: ${lastLine}` };
  }
};
