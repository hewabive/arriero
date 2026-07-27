import type {
  Instance,
  EndpointProbe,
  LlamaSlotActionName,
  LlamaSlotActionRequest,
  LlamaSlotActionResult,
} from "@arriero/core";

import {
  compactOptionalString,
  instanceBaseUrl,
  requestJsonProbe,
} from "../instances/endpoint.js";
import { llamaEndpointErrorMessage } from "./errors.js";

const ACTION_TIMEOUT_MS = 15 * 60 * 1_000;

function isFileNotFound(probe: EndpointProbe): boolean {
  return (
    probe.status === 404 &&
    llamaEndpointErrorMessage(probe) === "File Not Found"
  );
}

export async function requestLlamaModelAction(
  instance: Instance,
  action: "load" | "unload" | "reload",
  model?: string,
) {
  const baseUrl = instanceBaseUrl(instance);
  if (!baseUrl) {
    throw new Error("UNIX socket model actions are not implemented yet");
  }

  if (action === "reload") {
    return {
      action,
      model: null,
      fallback: null,
      response: await requestJsonProbe(`${baseUrl}/models?reload=1`, {
        timeoutMs: ACTION_TIMEOUT_MS,
      }),
    };
  }

  if (!model) {
    throw new Error("model is required");
  }

  const response = await requestJsonProbe(`${baseUrl}/models/${action}`, {
    method: "POST",
    body: JSON.stringify({ model }),
    headers: { "content-type": "application/json" },
    timeoutMs: ACTION_TIMEOUT_MS,
  });

  if (action === "load" && isFileNotFound(response)) {
    const query = new URLSearchParams({ model, autoload: "true" });
    return {
      action,
      model,
      fallback: "/props?autoload=true",
      response: await requestJsonProbe(`${baseUrl}/props?${query.toString()}`, {
        timeoutMs: ACTION_TIMEOUT_MS,
      }),
    };
  }

  return {
    action,
    model,
    fallback: null,
    response,
  };
}

export async function requestLlamaSlotAction(
  instance: Instance,
  action: LlamaSlotActionName,
  slotId: number,
  input: LlamaSlotActionRequest,
): Promise<LlamaSlotActionResult> {
  const baseUrl = instanceBaseUrl(instance);
  if (!baseUrl) {
    throw new Error("UNIX socket slot actions are not implemented yet");
  }

  const query = new URLSearchParams({ action });
  const filename = compactOptionalString(input.filename);
  const model = compactOptionalString(input.model);
  const body = {
    ...(model ? { model } : {}),
    ...(filename ? { filename } : {}),
  };

  return {
    action,
    slotId,
    model: model ?? null,
    filename: filename ?? null,
    response: await requestJsonProbe(
      `${baseUrl}/slots/${slotId}?${query.toString()}`,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        timeoutMs: ACTION_TIMEOUT_MS,
      },
    ),
  };
}
