import { collectEstimatorContent } from "./token-estimate-content.js";

const perMessageOverheadTokens = 4;

const cjkRanges: Array<[number, number]> = [
  [0x2e80, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
  [0x20000, 0x3134f],
];

function codePointWeight(code: number): number {
  if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
    return 0.25;
  }
  if (code < 0x80) {
    const isAlnum =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a);
    return isAlnum ? 0.25 : 0.4;
  }
  if (code >= 0x0400 && code <= 0x04ff) {
    return 0.45;
  }
  for (const [start, end] of cjkRanges) {
    if (code >= start && code <= end) {
      return 1;
    }
  }
  return 0.5;
}

export function estimateTextTokens(text: string): number {
  let total = 0;
  for (const char of text) {
    total += codePointWeight(char.codePointAt(0) ?? 0);
  }
  return Math.ceil(total);
}

export function estimateRequestTokens(body: unknown): {
  tokens: number;
  imageCount: number;
} {
  const { texts, messageCount, imageCount } = collectEstimatorContent(body);
  let total = messageCount * perMessageOverheadTokens;
  for (const text of texts) {
    total += estimateTextTokens(text);
  }
  return { tokens: Math.ceil(total), imageCount };
}
