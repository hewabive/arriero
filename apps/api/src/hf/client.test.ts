import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fetchHfPathsInfo,
  fetchHfRepoInfo,
  fetchHfTree,
  HfHubError,
  hfResolveUrl,
} from "./client.js";

type RecordedRequest = {
  url: string;
  init: RequestInit | undefined;
};

function jsonResponse(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => Response,
): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    requests.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

test("fetchHfRepoInfo resolves sha and normalizes gated", async () => {
  const { fetchImpl, requests } = stubFetch(() =>
    jsonResponse({ sha: "a".repeat(40), gated: "manual", private: false }),
  );
  const info = await fetchHfRepoInfo("owner/repo", "main", {
    fetchImpl,
    token: null,
  });
  assert.equal(info.sha, "a".repeat(40));
  assert.equal(info.gated, true);
  assert.equal(info.private, false);
  assert.match(
    requests[0]?.url ?? "",
    /\/api\/models\/owner\/repo\/revision\/main$/,
  );
});

test("fetchHfTree follows the next link and concatenates pages", async () => {
  const page2Url =
    "https://huggingface.co/api/models/owner/repo/tree/main?cursor=abc";
  const { fetchImpl, requests } = stubFetch((url) => {
    if (url.includes("cursor=abc")) {
      return jsonResponse([
        { type: "file", path: "b.gguf", size: 2, oid: "oid-b" },
      ]);
    }
    return jsonResponse(
      [
        {
          type: "file",
          path: "a.gguf",
          oid: "oid-a",
          lfs: { oid: "sha-a", size: 5 },
        },
        { type: "directory", path: "sub", oid: "oid-dir" },
      ],
      { headers: { link: `<${page2Url}>; rel="next"` } },
    );
  });
  const tree = await fetchHfTree("owner/repo", "main", {
    fetchImpl,
    token: null,
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(
    tree.files.map((file) => file.path),
    ["a.gguf", "b.gguf"],
  );
  assert.equal(tree.files[0]?.size, 5);
  assert.equal(tree.files[0]?.lfs?.oid, "sha-a");
  assert.equal(tree.truncated, false);
});

test("fetchHfPathsInfo chunks requests at 1000 paths", async () => {
  const bodies: string[] = [];
  const { fetchImpl } = stubFetch((_url, init) => {
    bodies.push(String(init?.body));
    return jsonResponse([]);
  });
  const paths = Array.from({ length: 1_500 }, (_, i) => `f${i}.bin`);
  await fetchHfPathsInfo("owner/repo", "main", paths, false, {
    fetchImpl,
    token: null,
  });
  assert.equal(bodies.length, 2);
  const first = JSON.parse(bodies[0] ?? "{}") as { paths: string[] };
  const second = JSON.parse(bodies[1] ?? "{}") as { paths: string[] };
  assert.equal(first.paths.length, 1_000);
  assert.equal(second.paths.length, 500);
});

test("errors map HTTP statuses to typed kinds", async () => {
  for (const [status, kind] of [
    [401, "unauthorized"],
    [403, "gated"],
    [404, "not-found"],
    [429, "rate-limited"],
    [500, "upstream"],
  ] as const) {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ error: "nope" }, { status }),
    );
    await assert.rejects(
      fetchHfRepoInfo("owner/repo", "main", { fetchImpl, token: null }),
      (error: unknown) =>
        error instanceof HfHubError &&
        error.kind === kind &&
        error.status === status,
    );
  }
});

test("token is sent as a bearer header and omitted when null", async () => {
  const { fetchImpl, requests } = stubFetch(() =>
    jsonResponse({ sha: "b".repeat(40) }),
  );
  await fetchHfRepoInfo("owner/repo", "main", {
    fetchImpl,
    token: "hf_secret",
  });
  const headers = requests[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer hf_secret");

  await fetchHfRepoInfo("owner/repo", "main", { fetchImpl, token: null });
  const anonymousHeaders = requests[1]?.init?.headers as Record<string, string>;
  assert.equal(anonymousHeaders.authorization, undefined);
});

test("hfResolveUrl encodes repo, revision and path segments", () => {
  assert.equal(
    hfResolveUrl("owner/repo", "refs/pr/1", "sub dir/file.gguf"),
    "https://huggingface.co/owner/repo/resolve/refs%2Fpr%2F1/sub%20dir/file.gguf",
  );
});
