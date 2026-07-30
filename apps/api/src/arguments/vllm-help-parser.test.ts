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

test("ignores option-shaped prose and JSON CLI examples", () => {
  const options =
    parseVllmArgumentOptions(`usage: vllm serve [model_tag] [options]

Search by using: \`--help=<ConfigGroup>\` to explore options by section (e.g.,
--help=ModelConfig, --help=Frontend)
  Use \`--help=all\` to show all available flags at once.

options:
  --enable-log-requests, --no-enable-log-requests
                        Enable request logging, dependent on log
                        level:
                        - INFO: request metadata.
  -h, --help            show this help message and exit

Frontend:
  --host HOST           Host name

When passing JSON CLI arguments, the following sets of arguments are equivalent:
   --json-arg '{"key1": "value1"}'
   --json-arg.key1 value1
`);

  assert.deepEqual(options.map((option) => option.primaryName).sort(), [
    "--enable-log-requests",
    "--help",
    "--host",
  ]);
  assert.equal(
    options.find((option) => option.primaryName === "--help")?.category,
    options.find((option) => option.primaryName === "--enable-log-requests")
      ?.category,
  );
  assert.match(
    options.find((option) => option.primaryName === "--enable-log-requests")
      ?.help ?? "",
    /level:/,
  );
});

test("returns unique primary names", () => {
  const options = parseVllmArgumentOptions(`usage: vllm serve [options]

options:
  --host HOST           Host name
  --port PORT           Port

When passing JSON CLI arguments, the following sets of arguments are equivalent:
   --json-arg '{"key1": "value1"}'
   --json-arg '{"key2": "value2"}'
`);
  const names = options.map((option) => option.primaryName);

  assert.equal(new Set(names).size, names.length);
  assert.equal(names.includes("--json-arg"), false);
});
