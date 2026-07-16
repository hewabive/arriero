import assert from "node:assert/strict";
import test from "node:test";

import { parseSglangArgumentOptions } from "./sglang-help-parser.js";

test("parses SGLang argparse groups, aliases, choices, and list values", () => {
  const options = parseSglangArgumentOptions(`bootstrap log
usage: sglang serve [options]

Server:
  --host HOST                  Bind host
  --tensor-parallel-size N, --tp N
                               Tensor parallel size

KTransformers:
  --kt-method {AMXINT4,BF16,LLAMAFILE}
                               Compute method
  --kt-numa-nodes NODE [NODE ...]
                               NUMA nodes
`);
  assert.equal(
    options.find((item) => item.primaryName === "--host")?.category,
    "Server",
  );
  assert.ok(
    options
      .find((item) => item.primaryName === "--tensor-parallel-size")
      ?.names.includes("--tp"),
  );
  assert.deepEqual(
    options.find((item) => item.primaryName === "--kt-method")?.allowedValues,
    ["AMXINT4", "BF16", "LLAMAFILE"],
  );
  assert.equal(
    options.find((item) => item.primaryName === "--kt-numa-nodes")?.valueType,
    "list",
  );
});
