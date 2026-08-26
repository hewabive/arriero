import {
  ApiEndpointUpdateSchema,
  ApiProxyModelUpdateSchema,
  ApiProxyPipelineUpdateSchema,
  ApiProxySettingsUpdateSchema,
  ApiProxySourceUpdateSchema,
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

test("ApiProxyPipelineUpdateSchema does not apply create defaults and clears entry with null", () => {
  assert.deepEqual(ApiProxyPipelineUpdateSchema.parse({ name: "renamed" }), {
    name: "renamed",
  });
  assert.deepEqual(ApiProxyPipelineUpdateSchema.parse({ entry: null }), {
    entry: null,
  });
});

test("ApiProxySourceUpdateSchema does not apply create defaults", () => {
  assert.deepEqual(ApiProxySourceUpdateSchema.parse({ apiKey: "sk-test" }), {
    apiKey: "sk-test",
  });
});

test("ApiProxySettingsUpdateSchema does not apply settings defaults", () => {
  assert.deepEqual(ApiProxySettingsUpdateSchema.parse({}), {});
});

test("ApiEndpointUpdateSchema does not apply catalog defaults", () => {
  assert.deepEqual(ApiEndpointUpdateSchema.parse({ name: "renamed" }), {
    name: "renamed",
  });
});
