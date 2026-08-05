import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { helpBlockFlagRows, phantomHelpRows } from "./docs-source.js";

const block = [
  "<!-- HELP_START -->",
  "| Argument | Explanation |",
  "| -------- | ----------- |",
  "| `-h, --help, --usage` | print usage and exit |",
  "| `--repeat-last-n N` | last n tokens to consider (default: 64) |",
  "| `--typical, --typical-p N` | locally typical sampling |",
  "| `--spec-type none,draft-simple,draft-mtp` | speculative decoding type |",
  "| `--spec-draft-hf, -hfd, -hfrd, --hf-repo-draft <user>/<model>[:quant]` | draft model repo |",
  "| `-tk, --talker-model FILE` | path to the talker gguf |",
  "<!-- HELP_END -->",
].join("\n");

describe("helpBlockFlagRows", () => {
  it("extracts flag tokens per row and skips header and separator", () => {
    const rows = helpBlockFlagRows(block);
    assert.deepEqual(
      rows.map((row) => row.flags),
      [
        ["-h", "--help", "--usage"],
        ["--repeat-last-n"],
        ["--typical", "--typical-p"],
        ["--spec-type"],
        ["--spec-draft-hf", "-hfd", "-hfrd", "--hf-repo-draft"],
        ["-tk", "--talker-model"],
      ],
    );
  });

  it("keeps the original cell text as the row label", () => {
    const rows = helpBlockFlagRows(block);
    assert.equal(rows[5]?.label, "-tk, --talker-model FILE");
  });
});

describe("phantomHelpRows", () => {
  const argSource = [
    'add_opt(common_arg({"-h", "--help", "--usage"},',
    'add_opt(common_arg({"--repeat-last-n"}, "N",',
    'add_opt(common_arg({"--typical", "--typical-p"}, "N",',
    'add_opt(common_arg({"--spec-type"}, "TYPE",',
    'add_opt(common_arg({"-hfd", "-hfrd", "--hf-repo-draft"},',
  ].join("\n");

  it("reports rows whose flags all miss the arg parser source", () => {
    assert.deepEqual(phantomHelpRows(block, argSource), [
      "-tk, --talker-model FILE",
    ]);
  });

  it("accepts a row when any alias matches", () => {
    assert.equal(
      phantomHelpRows(block, argSource).includes(
        "--spec-draft-hf, -hfd, -hfrd, --hf-repo-draft <user>/<model>[:quant]",
      ),
      false,
    );
  });

  it("returns empty for a fully covered block", () => {
    const covered = [
      "| `--ctx-size N` | context size |",
      "| -------- | ----------- |",
    ].join("\n");
    assert.deepEqual(phantomHelpRows(covered, '{"-c", "--ctx-size"}'), []);
  });
});
