export const forceAnswerReasoningTags = {
  open: "<think>",
  close: "</think>",
} as const;

export function buildThinkForceAnswerTail(reasoningText: string): string {
  const trimmed = reasoningText.trimEnd();
  return `${forceAnswerReasoningTags.open}\n${trimmed}\n${forceAnswerReasoningTags.close}\n\n`;
}
