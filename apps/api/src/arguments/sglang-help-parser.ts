import { parseLlamaArgumentOptions } from "./help-parser.js";

export function parseSglangArgumentOptions(helpOutput: string) {
  const lines = helpOutput.split(/\r?\n/);
  const repeatedValueNames = new Set<string>();
  for (const line of lines) {
    if (!/\[[^\]]*\.\.\.[^\]]*\]/.test(line)) continue;
    for (const name of line.match(/--[A-Za-z0-9][A-Za-z0-9-]*/g) ?? []) {
      repeatedValueNames.add(name);
    }
  }
  const usageIndex = lines.findIndex((line) => /^usage:/i.test(line.trim()));
  const normalized = (usageIndex >= 0 ? lines.slice(usageIndex) : lines)
    .map((line) => {
      const group = /^([A-Za-z][A-Za-z0-9 _/-]+):\s*$/.exec(line.trim());
      return group ? `----- ${group[1]} -----` : line;
    })
    .join("\n");

  return parseLlamaArgumentOptions(normalized).map((option) => {
    const repeated = option.names.some((name) => repeatedValueNames.has(name));
    return {
      ...option,
      ...(repeated
        ? {
            valueType: "list" as const,
            control: {
              ...option.control,
              kind: "csv-list" as const,
              cliEncoding: "repeated" as const,
            },
          }
        : {}),
      helpRu:
        option.helpRuSource === "fallback"
          ? `Оригинальная справка SGLang: ${option.help || option.primaryName}`
          : option.helpRu,
    };
  });
}
