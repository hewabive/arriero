import assert from "node:assert/strict";
import test from "node:test";

import { resolveEnvironmentIndexVersions } from "./index-versions.js";
import type { IndexDistributionResult } from "./package-index.js";

function stubIndex(pages: Record<string, string[]>) {
  return async (url: string): Promise<IndexDistributionResult> => {
    const filenames = pages[url];
    if (!filenames) return { outcome: "not-found", detail: "404" };
    return {
      outcome: "ok",
      files: filenames.map((filename) => ({ filename, requiresPython: null })),
    };
  };
}

const GITEA = "https://gitea.local/api/packages/team/pypi/simple";

test("vLLM versions come back newest first", async () => {
  const result = await resolveEnvironmentIndexVersions({
    engine: "vllm",
    indexUrl: GITEA,
    fetcher: stubIndex({
      [`${GITEA}/vllm/`]: [
        "vllm-0.25.0-cp312-cp312-linux_x86_64.whl",
        "vllm-0.26.0-cp312-cp312-linux_x86_64.whl",
        "vllm-0.9.0-cp312-cp312-linux_x86_64.whl",
      ],
    }),
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(
    result.versions.map((entry) => entry.version),
    ["0.26.0", "0.25.0", "0.9.0"],
  );
  assert.deepEqual(result.versions[0]?.missingDistributions, []);
  assert.equal(result.versions[0]?.files.length, 1);
});

test("KTransformers flags versions that only one root distribution publishes", async () => {
  const result = await resolveEnvironmentIndexVersions({
    engine: "ktransformers",
    indexUrl: GITEA,
    fetcher: stubIndex({
      [`${GITEA}/kt-kernel/`]: [
        "kt_kernel-0.6.3.post1-cp312-cp312-linux_x86_64.whl",
        "kt_kernel-0.6.4-cp312-cp312-linux_x86_64.whl",
      ],
      [`${GITEA}/sglang-kt/`]: [
        "sglang_kt-0.6.3.post1-cp312-cp312-linux_x86_64.whl",
      ],
    }),
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(
    result.versions.map((entry) => [
      entry.version,
      entry.missingDistributions,
    ]),
    [
      ["0.6.4", ["sglang-kt"]],
      ["0.6.3.post1", []],
    ],
  );
});

test("a distribution absent from the index reports which one is missing", async () => {
  const result = await resolveEnvironmentIndexVersions({
    engine: "ktransformers",
    indexUrl: GITEA,
    fetcher: stubIndex({
      [`${GITEA}/kt-kernel/`]: [
        "kt_kernel-0.6.3.post1-cp312-cp312-linux_x86_64.whl",
      ],
    }),
  });
  assert.equal(result.status, "empty");
  assert.match(result.message ?? "", /sglang-kt not published/);
});

test("a missing root package on a URL without /simple hints at the cause", async () => {
  const result = await resolveEnvironmentIndexVersions({
    engine: "vllm",
    indexUrl: "https://gitea.local/api/packages/team/pypi",
    fetcher: stubIndex({}),
  });
  assert.equal(result.status, "not-found");
  assert.match(result.message ?? "", /does not end with \/simple/);
});

test("authentication and reachability failures are distinct states", async () => {
  const unauthorized = await resolveEnvironmentIndexVersions({
    engine: "vllm",
    indexUrl: GITEA,
    fetcher: async () => ({ outcome: "auth-required", detail: "401" }),
  });
  assert.equal(unauthorized.status, "auth-required");

  const offline = await resolveEnvironmentIndexVersions({
    engine: "vllm",
    indexUrl: GITEA,
    fetcher: async () => ({ outcome: "unreachable", detail: "ENOTFOUND" }),
  });
  assert.equal(offline.status, "unreachable");
  assert.equal(offline.message, "ENOTFOUND");
});

test("an unset index resolves against the public default", async () => {
  const seen: string[] = [];
  const result = await resolveEnvironmentIndexVersions({
    engine: "vllm",
    indexUrl: null,
    fetcher: async (url) => {
      seen.push(url);
      return { outcome: "ok", files: [] };
    },
  });
  assert.deepEqual(seen, ["https://pypi.org/simple/vllm/"]);
  assert.equal(result.indexUrl, "https://pypi.org/simple/");
  assert.equal(result.status, "empty");
});
