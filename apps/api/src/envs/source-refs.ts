import {
  CHAT_UI_REPOSITORY_URL,
  type EnvironmentEngine,
  type EnvironmentSourceRefs,
} from "@arriero/core";

import { redactGitOutput, runGit } from "../git/process.js";

const NODE_SOURCE_REPOSITORIES: Partial<Record<EnvironmentEngine, string>> = {
  "chat-ui": CHAT_UI_REPOSITORY_URL,
};

export function parseLsRemoteRefs(stdout: string): {
  tags: string[];
  branches: string[];
} {
  const tags: string[] = [];
  const branches: string[] = [];
  for (const line of stdout.split("\n")) {
    const ref = line.split("\t")[1]?.trim();
    if (!ref) continue;
    if (ref.startsWith("refs/tags/")) {
      tags.push(ref.slice("refs/tags/".length));
    } else if (ref.startsWith("refs/heads/")) {
      branches.push(ref.slice("refs/heads/".length));
    }
  }
  tags.sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }),
  );
  branches.sort((a, b) => a.localeCompare(b));
  return { tags, branches };
}

export async function resolveEnvironmentSourceRefs(
  engine: EnvironmentEngine,
): Promise<EnvironmentSourceRefs | null> {
  const url = NODE_SOURCE_REPOSITORIES[engine];
  if (!url) return null;
  try {
    const result = await runGit(process.cwd(), [
      "ls-remote",
      "--tags",
      "--heads",
      "--refs",
      url,
    ]);
    return {
      engine,
      url,
      status: "ok",
      message: null,
      ...parseLsRemoteRefs(result.stdout),
    };
  } catch (error) {
    return {
      engine,
      url,
      status: "unreachable",
      message: redactGitOutput((error as Error).message),
      tags: [],
      branches: [],
    };
  }
}
