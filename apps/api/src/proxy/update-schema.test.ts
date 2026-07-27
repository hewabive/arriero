import {
  ApiProxyModelUpdateSchema,
  ApiProxyTargetUpdateSchema,
} from "@arriero/core";
import assert from "node:assert/strict";
import test from "node:test";

test("ApiProxyTargetUpdateSchema does not apply create defaults", () => {
  assert.deepEqual(ApiProxyTargetUpdateSchema.parse({ name: "renamed" }), {
    name: "renamed",
  });
});

test("ApiProxyModelUpdateSchema does not apply create defaults", () => {
  assert.deepEqual(ApiProxyModelUpdateSchema.parse({ modelId: "public-id" }), {
    modelId: "public-id",
  });
});
