import type { ApiProxyInflightHandle } from "./inflight.js";
import {
  apiProxyOperationSpec,
  type ApiProxyProtocolOperation,
} from "./protocol.js";
import { safeJsonParse } from "./protocol-trace.js";
import { responseToolCalls, trailingToolResultIds } from "./tool-calls.js";

type ToolOperation = Pick<ApiProxyProtocolOperation, "protocol" | "endpoint">;

function toolShape(operation: ToolOperation) {
  return apiProxyOperationSpec(operation)?.toolContinuation ?? null;
}

export function markToolContinuation(
  inflight: ApiProxyInflightHandle,
  operation: ToolOperation,
  body: unknown,
): void {
  const shape = toolShape(operation);
  const toolCallIds = shape ? trailingToolResultIds(shape, body) : null;
  if (toolCallIds) {
    inflight.continueToolCalls(toolCallIds);
  }
}

export function recordNonStreamToolCalls(
  inflight: ApiProxyInflightHandle,
  operation: ToolOperation,
  text: string,
): void {
  const shape = toolShape(operation);
  const calls = shape ? responseToolCalls(shape, safeJsonParse(text)) : null;
  for (const call of calls ?? []) {
    inflight.appendToolCall(call);
  }
}
