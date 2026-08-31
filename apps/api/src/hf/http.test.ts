import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchDownloadImpl, hfRedirectedDownloadHeaders } from "./http.js";

test("download redirects strip credentials when the origin changes", () => {
  const headers = hfRedirectedDownloadHeaders(
    {
      authorization: "Bearer secret",
      cookie: "session=secret",
      range: "bytes=0-9",
    },
    new URL("https://huggingface.co/model/resolve/main/file"),
    new URL("https://cdn.example/file"),
  );
  assert.deepEqual(headers, { range: "bytes=0-9" });
});

test("download redirects retain credentials on the same origin", () => {
  const headers = {
    authorization: "Bearer secret",
    range: "bytes=0-9",
  };
  assert.equal(
    hfRedirectedDownloadHeaders(
      headers,
      new URL("https://huggingface.co/one"),
      new URL("https://huggingface.co/two"),
    ),
    headers,
  );
});

test("fetch download adapter can discard an unused response body", async () => {
  let canceled = false;
  const fetchImpl = (async () =>
    new Response(
      new ReadableStream({
        cancel: () => {
          canceled = true;
        },
      }),
    )) as typeof fetch;
  const response = await fetchDownloadImpl(fetchImpl)("https://example.com");
  await response.discard();
  assert.equal(canceled, true);
});
