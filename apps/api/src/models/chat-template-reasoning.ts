import type { GgufChatTemplateReasoning } from "@arriero/core";

const levelListPattern =
  /[a-z_]*reasoning_effort[a-z_]*\s+not\s+in\s*\(([^)]*)\)/;

const levelComparisonPattern =
  /[a-z_]*reasoning_effort\s*==\s*['"]([a-z][a-z_-]*)['"]/g;

const aliasPattern =
  /==\s*['"]([a-z][a-z_-]*)['"]\s*%\}\s*\{%-?\s*set\s+[a-z_]*reasoning_effort[a-z_]*\s*=\s*['"]([a-z][a-z_-]*)['"]/g;

const RAISE_CONTEXT_CHARS = 300;

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

function guardLevels(template: string): string[] | null {
  const listMatch = levelListPattern.exec(template);
  if (!listMatch?.[1]) {
    return null;
  }
  const items = quotedItems(listMatch[1]);
  return items.length >= 2 ? [...new Set(items)] : null;
}

function comparisonLevels(
  template: string,
  aliases: Record<string, string> | null,
): string[] | null {
  const items: string[] = [];
  for (const match of template.matchAll(levelComparisonPattern)) {
    const value = match[1];
    if (value && !aliases?.[value]) {
      items.push(value);
    }
  }
  const unique = [...new Set(items)];
  return unique.length >= 2 ? unique : null;
}

function raisesOnReasoningEffort(template: string): boolean {
  for (const match of template.matchAll(/raise_exception/g)) {
    const context = template.slice(
      Math.max(0, match.index - RAISE_CONTEXT_CHARS),
      match.index,
    );
    if (context.includes("reasoning_effort")) {
      return true;
    }
  }
  return false;
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
  let strict = false;
  if (usesReasoningEffort) {
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
    levels = guardLevels(template) ?? comparisonLevels(template, aliases);
    strict = raisesOnReasoningEffort(template);
  }

  return { usesReasoningEffort, usesEnableThinking, levels, aliases, strict };
}
