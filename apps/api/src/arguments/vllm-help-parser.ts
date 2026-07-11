import { parseLlamaArgumentOptions } from "./help-parser.js";

export function parseVllmArgumentOptions(helpOutput: string) {
  const lines = helpOutput.split(/\r?\n/);
  const usageIndex = lines.findIndex((line) => /^usage:/i.test(line.trim()));
  const normalized = (usageIndex >= 0 ? lines.slice(usageIndex) : lines)
    .map((line) => {
      const group = /^([A-Za-z][A-Za-z0-9 _/-]+):\s*$/.exec(line.trim());
      return group ? `----- ${group[1]} -----` : line;
    })
    .join("\n");

  return parseLlamaArgumentOptions(normalized).map((option) => ({
    ...option,
    helpRu:
      option.helpRuSource === "fallback"
        ? `Оригинальная справка vLLM: ${option.help || option.primaryName}`
        : option.helpRu,
  }));
}
