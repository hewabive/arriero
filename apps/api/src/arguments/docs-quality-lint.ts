import type {
  EngineArgumentDeclaration,
  EngineArgumentExtract,
} from "@arriero/core";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { argumentDocSlug, parseArgumentDocFile } from "./docs.js";
import { LlamaArgumentEstimationSchema } from "./estimation.js";

export type DocQualityIssue = {
  path: string;
  severity: "error" | "warning";
  message: string;
};

export type EngineDocCoverage = {
  engineId: string;
  documented: number;
  total: number;
};

export type EngineDocContext = {
  engineId: string;
  optionsByPrimaryName: Map<string, EngineArgumentDeclaration>;
  knownFlags: Set<string>;
};

const stalePatterns = [
  /Этот файл создан автоматически/i,
  /Для точного описания механики нужно проверить/i,
  /Что проверить агенту перед завершением/i,
  /Автоматически связанные аргументы/i,
  /\bTODO\b/i,
];

const requiredFrontmatter = [
  "schema",
  "primaryName",
  "title",
  "summary",
  "category",
  "valueType",
  "estimation",
  "aliases",
  "related",
];

const obsoleteFrontmatter = [
  "docStatus",
  "reviewedHelpHash",
  "reviewedLlamaCppCommit",
];

const validPresetSupport = new Set([
  "supported",
  "unsupported",
  "preset-only",
  "model-managed",
  "router-managed",
]);

const engineRequiredFrontmatter = [
  "schema",
  "engine",
  "primaryName",
  "title",
  "summary",
  "related",
];

const engineForbiddenFrontmatter = [
  "estimation",
  "valueType",
  "aliases",
  "allowedValues",
  "env",
];

export function argumentDocFiles(directory: string) {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".md"))
    .filter((name) => !name.startsWith("_") && name !== "README.md")
    .map((name) => resolve(directory, name))
    .sort((left, right) => left.localeCompare(right));
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isBlank(value: unknown) {
  if (value === undefined || value === null) {
    return true;
  }
  return typeof value === "string" ? value.trim().length === 0 : false;
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function shorten(value: string, limit = 80) {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function firstHelpSentence(help: string) {
  const normalized = normalizeText(help);
  return normalized.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] ?? normalized;
}

export function lintLlamaArgumentDoc(path: string): DocQualityIssue[] {
  const issues: DocQualityIssue[] = [];
  const raw = readFileSync(path, "utf8");
  const parsed = parseArgumentDocFile(raw);

  for (const key of requiredFrontmatter) {
    if (!(key in parsed.frontmatter)) {
      issues.push({
        path,
        severity: "error",
        message: `missing frontmatter field: ${key}`,
      });
    }
  }

  const summary = stringValue(parsed.frontmatter.summary);
  const presetSupport = stringValue(parsed.frontmatter.presetSupport);

  for (const key of obsoleteFrontmatter) {
    if (key in parsed.frontmatter) {
      issues.push({
        path,
        severity: "error",
        message: `obsolete frontmatter field: ${key}`,
      });
    }
  }

  if (presetSupport && !validPresetSupport.has(presetSupport)) {
    issues.push({
      path,
      severity: "error",
      message: `invalid presetSupport: ${presetSupport}`,
    });
  }

  const estimation = stringValue(parsed.frontmatter.estimation);
  if (
    estimation &&
    !LlamaArgumentEstimationSchema.safeParse(estimation).success
  ) {
    issues.push({
      path,
      severity: "error",
      message: `invalid estimation: ${estimation}`,
    });
  }

  if (
    !summary ||
    /чернов(ая|ой|ое)\s+инженерн/i.test(summary) ||
    /создан[а-я\s]+автоматически/i.test(summary)
  ) {
    issues.push({
      path,
      severity: "warning",
      message: "summary is empty or still reads like a draft",
    });
  }

  for (const pattern of stalePatterns) {
    if (pattern.test(raw)) {
      issues.push({
        path,
        severity: "error",
        message: `stale generated text matched ${pattern}`,
      });
    }
  }

  return issues;
}

export function engineDocContext(
  engineId: string,
  extract: EngineArgumentExtract,
): EngineDocContext {
  return {
    engineId,
    optionsByPrimaryName: new Map(
      extract.options.map((option) => [option.flags[0]!, option]),
    ),
    knownFlags: new Set(extract.options.flatMap((option) => option.flags)),
  };
}

export function lintEngineArgumentDoc(
  path: string,
  context: EngineDocContext,
): DocQualityIssue[] {
  const issues: DocQualityIssue[] = [];
  const raw = readFileSync(path, "utf8");
  const parsed = parseArgumentDocFile(raw);
  const error = (message: string) =>
    issues.push({ path, severity: "error", message });

  for (const key of engineRequiredFrontmatter) {
    if (!(key in parsed.frontmatter)) {
      error(`missing frontmatter field: ${key}`);
      continue;
    }
    if (isBlank(parsed.frontmatter[key])) {
      error(`empty frontmatter field: ${key}`);
    }
  }

  for (const key of engineForbiddenFrontmatter) {
    if (key in parsed.frontmatter) {
      error(`unsupported frontmatter field: ${key}`);
    }
  }

  const engine = stringValue(parsed.frontmatter.engine);
  if (engine && engine !== context.engineId) {
    error(`engine mismatch: expected ${context.engineId}, found ${engine}`);
  }

  const primaryName = stringValue(parsed.frontmatter.primaryName);
  const option = context.optionsByPrimaryName.get(primaryName);

  if (primaryName && !option) {
    error(
      `unknown argument: ${primaryName} is not declared in the ${context.engineId} extract`,
    );
  }

  if (primaryName) {
    const expectedFile = `${argumentDocSlug(primaryName)}.md`;
    if (basename(path) !== expectedFile) {
      error(`file name does not match primaryName: expected ${expectedFile}`);
    }
  }

  if (option) {
    const expectedGroup = option.group ?? "";
    const declaredGroup = stringValue(parsed.frontmatter.group);
    if (declaredGroup !== expectedGroup) {
      error(
        `group mismatch: expected ${expectedGroup || "(none)"}, found ${declaredGroup || "(none)"}`,
      );
    }
  }

  const related = parsed.frontmatter.related;
  if ("related" in parsed.frontmatter && !Array.isArray(related)) {
    error("related must be a list of flags");
  }
  if (Array.isArray(related)) {
    for (const entry of related) {
      const flag = stringValue(entry);
      if (!flag) {
        error("related contains an empty entry");
        continue;
      }
      if (!context.knownFlags.has(flag)) {
        error(
          `unknown related flag: ${flag} is not declared in the ${context.engineId} extract`,
        );
        continue;
      }
      if (option?.flags.includes(flag)) {
        error(`related must not list the argument itself: ${flag}`);
      }
    }
  }

  for (const pattern of stalePatterns) {
    if (pattern.test(raw)) {
      error(`stale generated text matched ${pattern}`);
    }
  }

  const sentence = option ? firstHelpSentence(option.help) : "";
  if (sentence && !normalizeText(raw).includes(sentence)) {
    issues.push({
      path,
      severity: "warning",
      message: `upstream help is not quoted in the doc: ${shorten(sentence)}`,
    });
  }

  return issues;
}

export function lintEngineArgumentDocs(input: {
  engineId: string;
  docsDirectory: string;
  extract: EngineArgumentExtract;
}): {
  files: string[];
  issues: DocQualityIssue[];
  coverage: EngineDocCoverage;
} {
  const context = engineDocContext(input.engineId, input.extract);
  const files = argumentDocFiles(input.docsDirectory);
  return {
    files,
    issues: files.flatMap((file) => lintEngineArgumentDoc(file, context)),
    coverage: {
      engineId: input.engineId,
      documented: files.length,
      total: input.extract.options.length,
    },
  };
}
