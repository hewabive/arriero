import { parseLlamaArgumentOptions } from "./help-parser.js";

export function parseVllmArgumentOptions(helpOutput: string) {
  const lines = helpOutput.split(/\r?\n/);
  const usageIndex = lines.findIndex((line) => /^usage:/i.test(line.trim()));
  const relevant = usageIndex >= 0 ? lines.slice(usageIndex) : lines;
  const jsonExamplesIndex = relevant.findIndex((line) =>
    /^When passing JSON CLI arguments,/i.test(line),
  );
  const normalized = (
    jsonExamplesIndex >= 0 ? relevant.slice(0, jsonExamplesIndex) : relevant
  )
    .map((line) => {
      const group = /^([A-Za-z][A-Za-z0-9 _/-]+):\s*$/.exec(line);
      if (group) {
        return `----- ${group[1]} -----`;
      }

      const trimmed = line.trimStart();
      const indentation = line.length - trimmed.length;
      if (trimmed.startsWith("-") && indentation !== 2) {
        return "";
      }
      return line;
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
