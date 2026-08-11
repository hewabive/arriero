import type { EngineArgumentExtract } from "@arriero/core";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  engineDocContext,
  lintEngineArgumentDoc,
  lintEngineArgumentDocs,
} from "./docs-quality-lint.js";

const extract: EngineArgumentExtract = {
  schema: 1,
  engine: "vllm",
  entrypoint: "vllm serve",
  sourceFiles: ["vllm/engine/arg_utils.py"],
  options: [
    {
      flags: ["--max-model-len"],
      group: "ModelConfig",
      help: "Model context length. If unspecified, it is derived from the model config.",
      choices: null,
      type: null,
      optional: false,
      default: null,
      action: null,
      hidden: false,
      origin: "vllm/config/model.py:ModelConfig.max_model_len",
    },
    {
      flags: ["--tensor-parallel-size", "-tp"],
      group: "ParallelConfig",
      help: "Number of tensor parallel replicas.",
      choices: null,
      type: null,
      optional: false,
      default: null,
      action: null,
      hidden: false,
      origin: "vllm/config/parallel.py:ParallelConfig.tensor_parallel_size",
    },
    {
      flags: ["--aggregate-engine-logging"],
      group: null,
      help: "",
      choices: null,
      type: null,
      optional: false,
      default: null,
      action: "'store_true'",
      hidden: false,
      origin: "vllm/engine/arg_utils.py:add_cli_args",
    },
  ],
};

const context = engineDocContext("vllm", extract);

const frontmatter = [
  "schema: 1",
  "engine: vllm",
  'primaryName: "--max-model-len"',
  'title: "--max-model-len"',
  "summary: Ограничивает длину контекста, с которой стартует движок.",
  "group: ModelConfig",
  "related:",
  "  - --tensor-parallel-size",
];

const body = [
  "# --max-model-len",
  "",
  "## Оригинальная справка",
  "",
  "```text",
  "Model context length. If unspecified, it is derived",
  "from the model config.",
  "```",
  "",
  "## Кратко",
  "",
  "Значение задает верхнюю границу длины последовательности.",
];

function docText(lines = frontmatter, markdown = body) {
  return ["---", ...lines, "---", "", ...markdown, ""].join("\n");
}

function withDocsDirectory<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "arriero-engine-docs-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function lintDoc(fileName: string, text: string) {
  return withDocsDirectory((directory) => {
    const path = join(directory, fileName);
    writeFileSync(path, text, "utf8");
    return lintEngineArgumentDoc(path, context);
  });
}

function withoutFrontmatterLine(prefix: string) {
  return frontmatter.filter((line) => !line.startsWith(prefix));
}

test("a valid engine argument doc passes", () => {
  assert.deepEqual(lintDoc("max-model-len.md", docText()), []);
});

test("an argument missing from the extract is an error", () => {
  const issues = lintDoc(
    "max-model-length.md",
    docText([
      ...withoutFrontmatterLine("primaryName:"),
      'primaryName: "--max-model-length"',
    ]),
  );

  assert.ok(
    issues.some(
      (issue) =>
        issue.severity === "error" &&
        issue.message ===
          "unknown argument: --max-model-length is not declared in the vllm extract",
    ),
    JSON.stringify(issues),
  );
});

test("a file name that does not match primaryName is an error", () => {
  const issues = lintDoc("max-context-len.md", docText());

  assert.ok(
    issues.some(
      (issue) =>
        issue.severity === "error" &&
        issue.message ===
          "file name does not match primaryName: expected max-model-len.md",
    ),
    JSON.stringify(issues),
  );
});

test("related must reference flags declared by the same engine", () => {
  const unknown = lintDoc(
    "max-model-len.md",
    docText([...withoutFrontmatterLine("  - "), "  - --not-a-flag"]),
  );
  assert.ok(
    unknown.some(
      (issue) =>
        issue.severity === "error" &&
        issue.message ===
          "unknown related flag: --not-a-flag is not declared in the vllm extract",
    ),
    JSON.stringify(unknown),
  );

  const alias = lintDoc(
    "max-model-len.md",
    docText([...withoutFrontmatterLine("  - "), "  - -tp"]),
  );
  assert.deepEqual(alias, []);

  const itself = lintDoc(
    "max-model-len.md",
    docText([...withoutFrontmatterLine("  - "), "  - --max-model-len"]),
  );
  assert.ok(
    itself.some(
      (issue) =>
        issue.severity === "error" &&
        issue.message ===
          "related must not list the argument itself: --max-model-len",
    ),
    JSON.stringify(itself),
  );
});

test("frontmatter keys that belong to the extract are an error", () => {
  const issues = lintDoc(
    "max-model-len.md",
    docText([...frontmatter, "valueType: number", "aliases: []"]),
  );

  assert.deepEqual(
    issues.map((issue) => issue.message).sort(),
    [
      "unsupported frontmatter field: aliases",
      "unsupported frontmatter field: valueType",
    ],
    JSON.stringify(issues),
  );
});

test("required frontmatter must be present and non-empty", () => {
  const missing = lintDoc(
    "max-model-len.md",
    docText(withoutFrontmatterLine("summary:")),
  );
  assert.ok(
    missing.some(
      (issue) => issue.message === "missing frontmatter field: summary",
    ),
    JSON.stringify(missing),
  );

  const empty = lintDoc(
    "max-model-len.md",
    docText([...withoutFrontmatterLine("summary:"), "summary: ''"]),
  );
  assert.ok(
    empty.some((issue) => issue.message === "empty frontmatter field: summary"),
    JSON.stringify(empty),
  );
});

test("group must match the extract, including the null case", () => {
  const mismatch = lintDoc(
    "max-model-len.md",
    docText([...withoutFrontmatterLine("group:"), "group: ParallelConfig"]),
  );
  assert.ok(
    mismatch.some(
      (issue) =>
        issue.message ===
        "group mismatch: expected ModelConfig, found ParallelConfig",
    ),
    JSON.stringify(mismatch),
  );

  const grouplessDoc = docText(
    [
      "schema: 1",
      "engine: vllm",
      'primaryName: "--aggregate-engine-logging"',
      'title: "--aggregate-engine-logging"',
      "summary: Переключает агрегированное логирование.",
      "group: null",
      "related: []",
    ],
    ["# --aggregate-engine-logging", "", "Флаг без группы."],
  );
  assert.deepEqual(
    lintDoc("aggregate-engine-logging.md", grouplessDoc),
    [],
    grouplessDoc,
  );

  const groupless = lintDoc(
    "aggregate-engine-logging.md",
    grouplessDoc.replace("group: null", "group: EngineArgs"),
  );
  assert.ok(
    groupless.some(
      (issue) =>
        issue.message === "group mismatch: expected (none), found EngineArgs",
    ),
    JSON.stringify(groupless),
  );
});

test("a doc that never quotes the upstream help gets a warning", () => {
  const issues = lintDoc(
    "max-model-len.md",
    docText(frontmatter, [
      "# --max-model-len",
      "",
      "Здесь нет ни одной цитаты из исходной справки движка.",
    ]),
  );

  assert.equal(issues.length, 1, JSON.stringify(issues));
  assert.equal(issues[0]?.severity, "warning");
  assert.equal(
    issues[0]?.message,
    "upstream help is not quoted in the doc: Model context length.",
  );
});

test("stale template text is an error", () => {
  const issues = lintDoc(
    "max-model-len.md",
    docText(frontmatter, [...body, "", "TODO: дописать раздел."]),
  );

  assert.ok(
    issues.some(
      (issue) =>
        issue.severity === "error" && issue.message.includes("stale generated"),
    ),
    JSON.stringify(issues),
  );
});

test("an empty or missing args directory is a clean pass", () => {
  const empty = withDocsDirectory((directory) =>
    lintEngineArgumentDocs({
      engineId: "vllm",
      docsDirectory: directory,
      extract,
    }),
  );
  assert.deepEqual(empty.issues, []);
  assert.deepEqual(empty.coverage, {
    engineId: "vllm",
    documented: 0,
    total: 3,
  });

  const absent = lintEngineArgumentDocs({
    engineId: "vllm",
    docsDirectory: join(tmpdir(), "arriero-engine-docs-absent", "args"),
    extract,
  });
  assert.deepEqual(absent.issues, []);
  assert.deepEqual(absent.coverage, {
    engineId: "vllm",
    documented: 0,
    total: 3,
  });
});

test("directory linting reports coverage and per-file issues", () => {
  const result = withDocsDirectory((directory) => {
    writeFileSync(join(directory, "max-model-len.md"), docText(), "utf8");
    writeFileSync(
      join(directory, "_agent-prompt.md"),
      "TODO: это не документ аргумента",
      "utf8",
    );
    writeFileSync(
      join(directory, "tensor-parallel-size.md"),
      docText([
        "schema: 1",
        "engine: sglang",
        'primaryName: "--tensor-parallel-size"',
        'title: "--tensor-parallel-size"',
        "summary: Число tensor-parallel реплик.",
        "group: ParallelConfig",
        "related: []",
      ]),
      "utf8",
    );
    return lintEngineArgumentDocs({
      engineId: "vllm",
      docsDirectory: directory,
      extract,
    });
  });

  assert.equal(result.coverage.documented, 2);
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.message === "engine mismatch: expected vllm, found sglang",
    ),
    JSON.stringify(result.issues),
  );
  assert.ok(
    result.issues.every((issue) => !issue.path.endsWith("_agent-prompt.md")),
    JSON.stringify(result.issues),
  );
});
