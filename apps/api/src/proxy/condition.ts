import type { ApiProxyConditionPredicate } from "@arriero/core";

import { requestScopeText } from "./request-text.js";

export type ApiProxyConditionContext = {
  body: unknown;
  sourceId: string | null;
  estimateTokens: () => number;
};

export type ApiProxyConditionOutcome =
  | { ok: true; value: boolean; detail: string }
  | { ok: false; error: string };

export function evaluateApiProxyCondition(
  predicate: ApiProxyConditionPredicate,
  context: ApiProxyConditionContext,
): ApiProxyConditionOutcome {
  switch (predicate.type) {
    case "text-match": {
      const text = requestScopeText(context.body, predicate.scope);
      if (predicate.regex) {
        let matcher: RegExp;
        try {
          matcher = new RegExp(
            predicate.pattern,
            predicate.caseSensitive ? "" : "i",
          );
        } catch (error) {
          return {
            ok: false,
            error: `invalid regex /${predicate.pattern}/: ${(error as Error).message}`,
          };
        }
        const value = matcher.test(text);
        return {
          ok: true,
          value,
          detail: `${predicate.scope} ${value ? "matches" : "does not match"} /${predicate.pattern}/`,
        };
      }
      const haystack = predicate.caseSensitive ? text : text.toLowerCase();
      const needle = predicate.caseSensitive
        ? predicate.pattern
        : predicate.pattern.toLowerCase();
      const value = haystack.includes(needle);
      return {
        ok: true,
        value,
        detail: `${predicate.scope} ${value ? "contains" : "does not contain"} "${predicate.pattern}"`,
      };
    }
    case "token-estimate": {
      const estimate = context.estimateTokens();
      const value = estimate >= predicate.minTokens;
      return {
        ok: true,
        value,
        detail: `~${estimate} tokens ${value ? ">=" : "<"} ${predicate.minTokens}`,
      };
    }
    case "source": {
      const expected = predicate.sourceId ?? null;
      const actual = context.sourceId ?? null;
      const value = actual === expected;
      return {
        ok: true,
        value,
        detail: `source ${actual ?? "anonymous"} ${value ? "==" : "!="} ${expected ?? "anonymous"}`,
      };
    }
  }
}
