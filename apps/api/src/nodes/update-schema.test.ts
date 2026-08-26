import { FleetNodeUpdateSchema } from "@arriero/core";
import assert from "node:assert/strict";
import test from "node:test";

test("FleetNodeUpdateSchema does not apply record defaults", () => {
  assert.deepEqual(FleetNodeUpdateSchema.parse({ name: "renamed" }), {
    name: "renamed",
  });
});
