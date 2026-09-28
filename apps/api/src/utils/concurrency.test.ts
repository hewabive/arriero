import assert from "node:assert/strict";
import { test } from "node:test";

import { mapWithConcurrency } from "./concurrency.js";

test("keeps input order while running at most the limit at once", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency(
    [30, 10, 20, 5, 15],
    2,
    async (delayMs) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      active -= 1;
      return delayMs * 2;
    },
  );
  assert.deepEqual(results, [60, 20, 40, 10, 30]);
  assert.equal(peak, 2);
});

test("rejects with the first failure", async () => {
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 3, async (value) => {
      if (value === 2) {
        throw new Error("second failed");
      }
      return value;
    }),
    /second failed/,
  );
});

test("maps nothing without calling the mapper", async () => {
  assert.deepEqual(
    await mapWithConcurrency([], 4, async () => {
      throw new Error("unexpected call");
    }),
    [],
  );
});
