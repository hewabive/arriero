import {
  comparePackageVersions,
  isPreReleaseVersion,
} from "../envs/package-index.js";

const STABLE_TAG_PATTERN =
  /^v?\d+(?:\.\d+)*(?:[-_.]?(?:post|rev|r)[-_.]?\d*|-\d+)?$/i;

export function selectLatestStableTag(tags: string[]): string | null {
  let best: string | null = null;
  for (const raw of tags) {
    const tag = raw.trim();
    if (!STABLE_TAG_PATTERN.test(tag) || isPreReleaseVersion(tag)) continue;
    if (best === null || comparePackageVersions(tag, best) > 0) {
      best = tag;
    }
  }
  return best;
}
