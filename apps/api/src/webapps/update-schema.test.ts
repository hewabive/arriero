import { WebappUpdateSchema } from "@arriero/core";
import assert from "node:assert/strict";
import test from "node:test";

test("WebappUpdateSchema does not apply record defaults", () => {
  assert.deepEqual(WebappUpdateSchema.parse({ name: "renamed" }), {
    name: "renamed",
  });
  assert.deepEqual(WebappUpdateSchema.parse({ proxySourceId: null }), {
    proxySourceId: null,
  });
});
