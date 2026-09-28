import { isHfCommitSha, type HfRepoBrowse } from "@arriero/core";

import {
  fetchHfRepoInfo,
  fetchHfTree,
  type HfClientOptions,
} from "./client.js";
import { groupHfGgufFiles } from "./grouping.js";

export type HfRepoFiles = Pick<
  HfRepoBrowse,
  "repoId" | "commitSha" | "files" | "truncated"
>;

export async function browseHfRepo(
  input: { repoId: string; revision: string | null },
  options?: HfClientOptions,
): Promise<HfRepoBrowse> {
  const requestedRevision = input.revision ?? "main";
  const info = await fetchHfRepoInfo(input.repoId, requestedRevision, options);
  const tree = await fetchHfTree(input.repoId, info.sha, options);
  return {
    repoId: input.repoId,
    requestedRevision,
    commitSha: info.sha,
    gated: info.gated,
    private: info.private,
    files: tree.files,
    ggufVariants: groupHfGgufFiles(tree.files),
    truncated: tree.truncated,
  };
}

export async function browseHfRepoFiles(
  input: { repoId: string; revision: string },
  options?: HfClientOptions,
): Promise<HfRepoFiles> {
  const commitSha = isHfCommitSha(input.revision)
    ? input.revision.toLowerCase()
    : (await fetchHfRepoInfo(input.repoId, input.revision, options)).sha;
  const tree = await fetchHfTree(input.repoId, commitSha, options);
  return {
    repoId: input.repoId,
    commitSha,
    files: tree.files,
    truncated: tree.truncated,
  };
}
