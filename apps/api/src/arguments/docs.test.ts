import { ArgumentOptionSchema } from "@arriero/core";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseArgumentDocFile,
  resetArgumentDocIndexCache,
  withArgumentDocIndex,
} from "./docs.js";
import { extractGeneratedHelpBlock } from "./docs-source.js";

test("parseArgumentDocFile reads simple frontmatter and markdown", () => {
  const parsed = parseArgumentDocFile(`---
schema: 1
primaryName: --ctx-size
aliases:
  - -c
  - --ctx-size
---

# --ctx-size

Long-form engineering docs.
`);

  assert.equal(parsed.frontmatter.schema, 1);
  assert.equal(parsed.frontmatter.primaryName, "--ctx-size");
  assert.deepEqual(parsed.frontmatter.aliases, ["-c", "--ctx-size"]);
  assert.match(parsed.markdown, /Long-form engineering docs/);
});

test("extractGeneratedHelpBlock reads the generated README section", () => {
  const block = extractGeneratedHelpBlock(`# Server

before

<!-- HELP_START -->

| Argument | Explanation |
| -------- | ----------- |
| \`--port N\` | port |

<!-- HELP_END -->

after
`);

  assert.match(block, /^<!-- HELP_START -->/);
  assert.match(block, /`--port N`/);
  assert.match(block, /<!-- HELP_END -->\n$/);
  assert.doesNotMatch(block, /before|after/);
});

test("withArgumentDocIndex caches doc reads per path until reset", () => {
  const option = ArgumentOptionSchema.parse({
    primaryName: "--ctx-size",
    names: ["--ctx-size", "-c"],
    category: "common",
    valueHint: "N",
    valueType: "number",
    env: [],
    allowedValues: [],
    help: "",
    helpRu: "",
    helpRuSource: "fallback",
    deprecated: false,
  });
  const directory = mkdtempSync(join(tmpdir(), "arriero-arg-docs-"));
  const docPath = join(directory, "ctx-size.md");
  const docFile = (summary: string) =>
    `---\nsummary: ${summary}\n---\n\n# --ctx-size\n`;
  try {
    writeFileSync(docPath, docFile("first"));
    assert.equal(
      withArgumentDocIndex([option], directory)[0]?.doc.summary,
      "first",
    );
    writeFileSync(docPath, docFile("second"));
    assert.equal(
      withArgumentDocIndex([option], directory)[0]?.doc.summary,
      "first",
    );
    resetArgumentDocIndexCache();
    assert.equal(
      withArgumentDocIndex([option], directory)[0]?.doc.summary,
      "second",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
    resetArgumentDocIndexCache();
  }
});
