import { asObject } from "./json.js";

export const contextOverflowMessage = "Prompt is too long";

const llamaContextOverflowMessages = [
  /input \(\d+ tokens\) is larger than the max context size/i,
  /request \(\d+ tokens\) exceeds the available context size/i,
];

export function isLlamaContextOverflow(status: number, body: unknown): boolean {
  if (status !== 400) {
    return false;
  }
  const error = asObject(asObject(body)?.error);
  if (error?.type === "exceed_context_size_error") {
    return true;
  }
  const message =
    typeof error?.message === "string"
      ? error.message
      : typeof body === "string"
        ? body
        : null;
  return (
    message !== null &&
    llamaContextOverflowMessages.some((pattern) => pattern.test(message))
  );
}
