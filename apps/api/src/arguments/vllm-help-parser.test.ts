import assert from "node:assert/strict";
import test from "node:test";

import { parseVllmArgumentOptions } from "./vllm-help-parser.js";

test("parses vllm argparse groups, choices, and paired booleans", () => {
  const options = parseVllmArgumentOptions(`INFO import preamble
usage: vllm serve [model_tag] [options]

Frontend:
  --host HOST           Host name (default: 0.0.0.0)
  --dtype {auto,float16,bfloat16}
                        Data type (default: auto)
  --enable-log-requests, --no-enable-log-requests
                        Enable request logging. (default: True)
`);
  assert.equal(
    options.find((item) => item.primaryName === "--host")?.category,
    "Frontend",
  );
  assert.deepEqual(
    options.find((item) => item.primaryName === "--dtype")?.allowedValues,
    ["auto", "float16", "bfloat16"],
  );
  assert.equal(
    options.find((item) => item.primaryName === "--enable-log-requests")
      ?.valueType,
    "boolean",
  );
});
