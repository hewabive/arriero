import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";

import { config } from "../config.js";
import { resetSettingsCache } from "../settings/store.js";
import {
  getLlamaSourceSyncReport,
  parseRpcServerUsageFlags,
  rpcServerFlagDivergences,
} from "./source-sync.js";

const printUsage = (extraLines: string[] = [], drop: string[] = []) => {
  const lines = [
    `  -h, --help                       show this help message and exit\\n`,
    `  -t, --threads N                  number of threads for the CPU device (default: %d)\\n`,
    `  -d, --device <dev1,dev2,...>     comma-separated list of devices\\n`,
    `  -H, --host HOST                  host to bind to (default: %s)\\n`,
    `  -p, --port PORT                  port to bind to (default: %d)\\n`,
    `  -c, --cache                      enable local file cache\\n`,
    ...extraLines,
  ].filter((line) => !drop.some((token) => line.includes(token)));

  return [
    "static void print_usage(int /*argc*/, char ** argv, rpc_server_params params) {",
    `    fprintf(stderr, "Usage: %s [options]\\n\\n", argv[0]);`,
    `    fprintf(stderr, "options:\\n");`,
    ...lines.map((line) => `    fprintf(stderr, "${line}");`),
    `    fprintf(stderr, "\\n");`,
    "}",
    "",
    "int main(int argc, char * argv[]) {",
    `    fprintf(stderr, "         Never expose the RPC server to an open network!\\n");`,
    "}",
  ].join("\n");
};

test("parseRpcServerUsageFlags extracts flag pairs and ignores prose", () => {
  const flags = parseRpcServerUsageFlags(printUsage());
  assert.deepEqual(
    flags.map((flag) => ({ short: flag.short, long: flag.long })),
    [
      { short: "-h", long: "--help" },
      { short: "-t", long: "--threads" },
      { short: "-d", long: "--device" },
      { short: "-H", long: "--host" },
      { short: "-p", long: "--port" },
      { short: "-c", long: "--cache" },
    ],
  );
});

test("rpcServerFlagDivergences reports none when source matches the form", () => {
  const divergences = rpcServerFlagDivergences(
    parseRpcServerUsageFlags(printUsage()),
  );
  assert.equal(divergences.length, 0);
});

test("rpcServerFlagDivergences flags a new upstream flag as unprobed", () => {
  const divergences = rpcServerFlagDivergences(
    parseRpcServerUsageFlags(
      printUsage([
        `  -m, --mem N                      host cache size in MiB (default: %d)\\n`,
      ]),
    ),
  );
  assert.equal(divergences.length, 1);
  assert.equal(divergences[0]!.kind, "unprobed");
  assert.match(divergences[0]!.label, /--mem/);
});

test("rpcServerFlagDivergences flags a removed flag as stale", () => {
  const divergences = rpcServerFlagDivergences(
    parseRpcServerUsageFlags(printUsage([], ["--cache"])),
  );
  assert.equal(divergences.length, 1);
  assert.equal(divergences[0]!.kind, "stale");
  assert.match(divergences[0]!.label, /--cache/);
});

test("rpcServerFlagDivergences reports a rename as both unprobed and stale", () => {
  const divergences = rpcServerFlagDivergences(
    parseRpcServerUsageFlags(
      printUsage(
        [
          `  -d, --devices <dev1,dev2,...>    comma-separated list of devices\\n`,
        ],
        ["--device "],
      ),
    ),
  );
  const kinds = divergences.map((item) => item.kind).sort();
  assert.deepEqual(kinds, ["stale", "unprobed"]);
});

test("missing checkout is unavailable rather than in sync", async () => {
  writeFileSync(
    config.settingsFile,
    `${JSON.stringify(
      {
        sourceRepositories: [
          {
            id: "llama-cpp",
            adapter: "llama-cpp",
            originUrl: "https://github.com/ggml-org/llama.cpp.git",
            location: { type: "managed" },
            updatedAt: null,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  resetSettingsCache();
  const report = await getLlamaSourceSyncReport();
  assert.equal(report.status, "unavailable");
  assert.equal(report.repository.state, "missing");
  assert.equal(report.commit, null);
  assert.deepEqual(report.sections, []);
});
