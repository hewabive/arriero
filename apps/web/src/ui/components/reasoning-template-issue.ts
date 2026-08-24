import type { ReasoningTemplateIssue } from "@arriero/core";

export function reasoningTemplateIssueExplanation(
  issue: ReasoningTemplateIssue,
): string {
  return issue === "strict"
    ? "The chat template takes reasoning_effort and rejects unknown values, but its level ladder was not recognized — requested levels are sent unchanged and can fail with a template error."
    : "The chat template takes reasoning_effort, but its level ladder was not recognized — requested levels are sent unchanged and may be silently ignored by the template.";
}
