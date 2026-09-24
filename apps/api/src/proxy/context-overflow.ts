import { asObject } from "./json.js";

export const contextOverflowMessage = "Prompt is too long";

const upstreamContextOverflowMessages = [
  /input \(\d+ tokens\) is larger than the max context size/i,
  /request \(\d+ tokens\) exceeds the available context size/i,
  /requested token count exceeds the model's maximum context length/i,
  /the input \(\d+ tokens\) is longer than the model's context length/i,
  /this model's maximum context length is \d+ tokens(?:\. however, (?:you requested|your request has)| and your request has)/i,
];

export function isUpstreamContextOverflow(
  status: number,
  body: unknown,
): boolean {
  if (status !== 400) {
    return false;
  }
  const record = asObject(body);
  const error = asObject(record?.error);
  if (error?.type === "exceed_context_size_error") {
    return true;
  }
  const message =
    typeof error?.message === "string"
      ? error.message
      : typeof record?.error === "string"
        ? record.error
        : typeof record?.message === "string"
          ? record.message
          : typeof body === "string"
            ? body
            : null;
  return (
    message !== null &&
    upstreamContextOverflowMessages.some((pattern) => pattern.test(message))
  );
}
