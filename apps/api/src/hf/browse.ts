import type { HfRepoBrowse } from "@arriero/core";

import {
  fetchHfRepoInfo,
  fetchHfTree,
  type HfClientOptions,
} from "./client.js";
import { groupHfGgufFiles } from "./grouping.js";

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
