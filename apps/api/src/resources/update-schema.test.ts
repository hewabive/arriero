import { MemoryPoolUpdateSchema } from "@arriero/core";
import assert from "node:assert/strict";
import test from "node:test";

test("MemoryPoolUpdateSchema does not apply record defaults", () => {
  assert.deepEqual(MemoryPoolUpdateSchema.parse({ name: "renamed" }), {
    name: "renamed",
  });
});
