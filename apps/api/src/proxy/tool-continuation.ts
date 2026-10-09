import type { ApiProxyInflightHandle } from "./inflight.js";
import {
  apiProxyOperationSpec,
  type ApiProxyProtocolOperation,
} from "./protocol.js";
import { responseToolCalls, trailingToolResultIds } from "./tool-calls.js";

type ToolOperation = Pick<ApiProxyProtocolOperation, "protocol" | "endpoint">;

function toolShape(operation: ToolOperation) {
  const spec = apiProxyOperationSpec(operation);
  return spec?.toolContinuation ? spec.responseShape : null;
}

export function isToolContinuation(
  operation: ToolOperation,
  body: unknown,
): boolean {
  const shape = toolShape(operation);
  return shape !== null && trailingToolResultIds(shape, body) !== null;
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
  body: unknown,
): void {
  const shape = toolShape(operation);
  for (const call of shape ? responseToolCalls(shape, body) : []) {
    inflight.appendToolCall(call);
  }
}
