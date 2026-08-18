import type { ArgumentOption, ArgumentValueType } from "@arriero/core";

import { defaultArgumentControl } from "./registry.js";
import { categoryNameRu, helpRuOverlay } from "./help-text-ru.js";
import { valueTypeFromChoices } from "./value-type.js";

type ParsedHelpOption = {
  category: string;
  optionText: string;
  help: string;
};

function parseHelpOutput(helpOutput: string): ParsedHelpOption[] {
  const parsed: ParsedHelpOption[] = [];
  const lines = helpOutput.split(/\r?\n/);
  let category = "common params";
  let current: ParsedHelpOption | null = null;

  const flush = () => {
    if (current) {
      current.help = current.help.replace(/\s+/g, " ").trim();
      parsed.push(current);
    }
  };

  const splitOptionLine = (line: string) => {
    const trimmed = line.trimEnd();
    const separators = [...trimmed.matchAll(/\s{2,}/g)]
      .map((match) => ({
        index: match.index ?? -1,
        length: match[0].length,
      }))
      .filter(({ index, length }) => {
        const before = trimmed.slice(0, index).trim();
        const after = trimmed.slice(index + length).trim();
        return before && after && !after.startsWith("-");
      });
    const separator = separators.at(-1);
    if (!separator) {
      return { optionText: trimmed.trim(), help: "" };
    }
    return {
      optionText: trimmed.slice(0, separator.index).trim(),
      help: trimmed.slice(separator.index + separator.length).trim(),
    };
  };

  for (const line of lines) {
    const section = line.match(/^-{5}\s+(.+?)\s+-{5}$/);
    if (section) {
      flush();
      current = null;
      category = section[1]!.trim();
      continue;
    }

    if (!line.trim()) {
      continue;
    }

    const startsOption =
      line.trimStart().startsWith("-") && line.search(/\S/) < 10;

    if (startsOption) {
      const { optionText, help } = splitOptionLine(line);
      flush();
      current = {
        category,
        optionText,
        help,
      };
      continue;
    }

    if (current) {
      current.help += `${current.help ? " " : ""}${line.trim()}`;
    }
  }

  flush();
  return parsed;
}

function namesFromOptionText(optionText: string) {
  const matches =
    optionText.match(/(?:^|[\s,])-{1,2}[A-Za-z0-9][A-Za-z0-9_.-]*/g) ?? [];
  return [...new Set(matches.map((item) => item.trim().replace(/,$/, "")))];
}

function valueHintFromOptionText(optionText: string, names: string[]) {
  let rest = optionText;
  for (const name of names) {
    rest = rest.replace(name, " ");
  }
  rest = rest.replace(/\s+/g, " ").trim();
  rest = rest
    .split(/\s+/)
    .filter((item) => !/^,+$/.test(item))
    .join(" ");
  if (!rest.replace(/,/g, "").trim()) {
    return null;
  }
  return rest || null;
}

function primaryName(names: string[]) {
  return (
    names.find((name) => name.startsWith("--") && !name.startsWith("--no-")) ??
    names.find((name) => name.startsWith("--")) ??
    names[0]!
  );
}

function allowedValues(valueHint: string | null, help: string) {
  if (!valueHint) {
    return [];
  }

  const braced = valueHint.match(/^\{(.+)\}$/);
  if (braced) {
    return braced[1]!
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  const bracket = valueHint.match(/^\[(.+)\]$/);
  if (bracket) {
    return bracket[1]!
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  const allowedLine = help.match(/allowed values:\s*([A-Za-z0-9_,.\s-]+)/i);
  if (allowedLine) {
    return allowedLine[1]!
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function inferValueType(input: {
  names: string[];
  valueHint: string | null;
  allowedValues: string[];
  help: string;
}): ArgumentValueType {
  const hint = input.valueHint?.toLowerCase() ?? "";
  const help = input.help.toLowerCase();
  const hasNegation = input.names.some(
    (name) => name.startsWith("--no-") || name.startsWith("-no"),
  );

  if (!input.valueHint) {
    return hasNegation || help.includes("whether to ") ? "boolean" : "flag";
  }

  const fromChoices = valueTypeFromChoices(input.allowedValues);
  if (fromChoices) {
    return fromChoices;
  }

  if (hint.includes("json")) return "json";
  if (hint.includes(",") || /comma[- ]separated/.test(help)) return "list";
  if (/\b(file|fname|path|dir|jinja_template_file)\b/.test(hint)) return "path";
  if (
    /^(n|port|index|seconds|similarity|seed|start|end)$/i.test(
      input.valueHint ?? "",
    )
  )
    return "number";
  if (hint === "<0|1>" || hint === "[on|off]" || hint === "[on|off|auto]")
    return "boolean";
  return "string";
}

function envFromHelp(help: string) {
  const env: string[] = [];
  const matches = help.matchAll(/\(env:\s*([^)]+)\)/g);
  for (const match of matches) {
    env.push(match[1]!.trim());
  }
  return env;
}

const HELP_DEFAULT_PATTERN = /\(default:\s*([^)]*)\)/g;

function helpDefaultValue(help: string): string | null {
  const matches = [...help.matchAll(HELP_DEFAULT_PATTERN)];
  const value = matches[matches.length - 1]?.[1]?.trim() ?? "";
  return value === "" ? null : value;
}

export function fillMissingDefaultValues(
  options: ArgumentOption[],
): ArgumentOption[] {
  return options.map((option) => {
    if (option.defaultValue !== null) {
      return option;
    }
    const defaultValue = helpDefaultValue(option.help);
    return defaultValue === null ? option : { ...option, defaultValue };
  });
}

function helpWithoutEnv(help: string) {
  return help
    .replace(/\(env:\s*[^)]+\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toOption(parsed: ParsedHelpOption): ArgumentOption | null {
  const names = namesFromOptionText(parsed.optionText);
  if (names.length === 0) {
    return null;
  }

  const valueHint = valueHintFromOptionText(parsed.optionText, names);
  const help = helpWithoutEnv(parsed.help);
  const values = allowedValues(valueHint, help);
  const name = primaryName(names);
  const category = categoryNameRu(parsed.category);

  return {
    primaryName: name,
    names,
    category,
    valueHint,
    valueType: inferValueType({
      names,
      valueHint,
      allowedValues: values,
      help,
    }),
    env: envFromHelp(parsed.help),
    allowedValues: values,
    defaultValue: helpDefaultValue(help),
    help,
    helpRu:
      helpRuOverlay[name] ??
      `Оригинальная справка llama.cpp: ${help || parsed.optionText}`,
    helpRuSource: helpRuOverlay[name] ? "builtin" : "fallback",
    doc: {
      exists: false,
      path: null,
      summary: null,
      updatedAt: null,
    },
    control: defaultArgumentControl({
      primaryName: name,
      valueType: inferValueType({
        names,
        valueHint,
        allowedValues: values,
        help,
      }),
      allowedValues: values,
    }),
    compatibility: {
      metadataSource: "binary",
      presentInBinary: true,
      binaryPrimaryName: name,
      binaryNames: names,
    },
    deprecated:
      /\bdeprecated\b/i.test(parsed.help) ||
      /\bdeprecated\b/i.test(parsed.optionText),
  };
}

export function parseLlamaArgumentOptions(helpOutput: string) {
  return parseHelpOutput(helpOutput)
    .map(toOption)
    .filter((option): option is ArgumentOption => Boolean(option))
    .sort(
      (left, right) =>
        left.category.localeCompare(right.category) ||
        left.primaryName.localeCompare(right.primaryName),
    );
}
