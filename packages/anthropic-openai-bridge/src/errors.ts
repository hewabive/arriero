import { asObject, asString } from "./json.js";

export type AnthropicErrorBody = {
  type: "error";
  error: { type: string; message: string };
};

const statusErrorTypes: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  529: "overloaded_error",
};

export function translateOpenAiError(
  status: number,
  body: unknown,
): AnthropicErrorBody {
  const errorValue = asObject(body)?.error;
  const message =
    asString(asObject(errorValue)?.message) ??
    asString(errorValue) ??
    asString(asObject(body)?.message) ??
    asString(body) ??
    `Upstream responded with status ${status}.`;
  return {
    type: "error",
    error: {
      type: statusErrorTypes[status] ?? "api_error",
      message,
    },
  };
}
