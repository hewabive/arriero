import assert from "node:assert/strict";
import { test } from "node:test";

import { selectLatestStableTag } from "./stable-tag.js";

test("selects the highest stable version tag", () => {
  assert.equal(
    selectLatestStableTag(["v0.9.2", "v0.10.1", "v0.10.0"]),
    "v0.10.1",
  );
});

test("ignores pre-release tags", () => {
  assert.equal(
    selectLatestStableTag(["v0.7.0rc1", "v0.6.4", "v0.8.0.dev0", "v0.7.0a1"]),
    "v0.6.4",
  );
});

test("treats post releases as stable and newer than the base release", () => {
  assert.equal(
    selectLatestStableTag(["v0.4.6", "v0.4.6.post1", "v0.4.5"]),
    "v0.4.6.post1",
  );
});

test("ignores tags that are not version numbers", () => {
  assert.equal(
    selectLatestStableTag(["b1234", "submission-2024", "nightly", "v1.2.3"]),
    "v1.2.3",
  );
});

test("accepts tags without the v prefix", () => {
  assert.equal(selectLatestStableTag(["0.5.0", "v0.4.0"]), "0.5.0");
});

test("returns null when no stable tag exists", () => {
  assert.equal(selectLatestStableTag(["v1.0.0rc1", "latest", ""]), null);
});
