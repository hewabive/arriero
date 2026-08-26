import { anthropicProtocolAdapter } from "./anthropic.js";
import { openAiProtocolAdapter } from "./openai.js";
import type {
  ApiProxyProtocolAdapter,
  ApiProxyProtocolOperation,
} from "./protocol.js";

export function adapterForProtocol(
  protocol: ApiProxyProtocolOperation["protocol"],
): ApiProxyProtocolAdapter {
  return protocol === "anthropic"
    ? anthropicProtocolAdapter
    : openAiProtocolAdapter;
}
