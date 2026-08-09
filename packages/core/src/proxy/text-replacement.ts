import type { ApiProxyTextReplacementRule } from "./pipeline-nodes.js";

export type ApiProxyTextReplacementResult = {
  text: string;
  count: number;
};

export function activeApiProxyTextReplacementRules(
  rules: ApiProxyTextReplacementRule[],
): ApiProxyTextReplacementRule[] {
  return rules.filter((rule) => rule.enabled && rule.find.length > 0);
}

export function applyApiProxyTextReplacements(
  text: string,
  rules: ApiProxyTextReplacementRule[],
): ApiProxyTextReplacementResult {
  let next = text;
  let count = 0;
  for (const rule of activeApiProxyTextReplacementRules(rules)) {
    const parts = next.split(rule.find);
    if (parts.length <= 1) {
      continue;
    }
    count += parts.length - 1;
    next = parts.join(rule.replace);
  }
  return { text: next, count };
}
