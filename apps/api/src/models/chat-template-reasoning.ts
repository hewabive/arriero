import type { GgufChatTemplateReasoning } from "@arriero/core";

const levelListPattern =
  /[a-z_]*reasoning_effort[a-z_]*\s+not\s+in\s*\(([^)]*)\)/;

const aliasPattern =
  /==\s*['"]([a-z][a-z_-]*)['"]\s*%\}\s*\{%-?\s*set\s+[a-z_]*reasoning_effort[a-z_]*\s*=\s*['"]([a-z][a-z_-]*)['"]/g;

function quotedItems(list: string): string[] {
  const items: string[] = [];
  for (const match of list.matchAll(/['"]([^'"]+)['"]/g)) {
    const value = match[1];
    if (value) {
      items.push(value);
    }
  }
  return items;
}

export function extractChatTemplateReasoning(
  template: string | null,
): GgufChatTemplateReasoning | null {
  if (template === null) {
    return null;
  }
  const usesReasoningEffort = /\breasoning_effort\b/.test(template);
  const usesEnableThinking = /\benable_thinking\b/.test(template);

  let levels: string[] | null = null;
  let aliases: Record<string, string> | null = null;
  if (usesReasoningEffort) {
    const listMatch = levelListPattern.exec(template);
    if (listMatch?.[1]) {
      const items = quotedItems(listMatch[1]);
      if (items.length >= 2) {
        levels = [...new Set(items)];
      }
    }
    const aliasEntries: Record<string, string> = {};
    for (const match of template.matchAll(aliasPattern)) {
      const from = match[1];
      const to = match[2];
      if (from && to && from !== to) {
        aliasEntries[from] = to;
      }
    }
    if (Object.keys(aliasEntries).length > 0) {
      aliases = aliasEntries;
    }
  }

  return { usesReasoningEffort, usesEnableThinking, levels, aliases };
}
