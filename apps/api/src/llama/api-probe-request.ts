import type { ApiProbeRequest, Instance } from "@arriero/core";

import {
  compactOptionalString,
  instanceBaseUrl,
} from "../instances/endpoint.js";

function withModel<T extends Record<string, unknown>>(
  body: T,
  model: string | undefined,
): T & { model?: string } {
  return model ? { ...body, model } : body;
}

function endpointWithAutoload(endpoint: string, autoload: boolean) {
  const query = new URLSearchParams({
    autoload: autoload ? "true" : "false",
  });
  return `${endpoint}?${query.toString()}`;
}

export function buildApiProbeRequestBody(
  input: ApiProbeRequest,
  options: { stream?: boolean } = {},
): {
  endpoint: string;
  body: Record<string, unknown>;
} {
  const systemPrompt = compactOptionalString(input.systemPrompt);

  if (input.kind === "tokenize") {
    return {
      endpoint: "/tokenize",
      body: withModel(
        {
          content: input.prompt,
          with_pieces: true,
          add_special: false,
          parse_special: true,
        },
        input.model,
      ),
    };
  }

  if (input.kind === "detokenize") {
    return {
      endpoint: "/detokenize",
      body: withModel(
        {
          tokens: input.tokens ?? [],
        },
        input.model,
      ),
    };
  }

  if (input.kind === "count-tokens") {
    return {
      endpoint: "/v1/messages/count_tokens",
      body: withModel(
        {
          ...(systemPrompt ? { system: systemPrompt } : {}),
          messages: [{ role: "user", content: input.prompt }],
        },
        input.model,
      ),
    };
  }

  if (input.kind === "apply-template") {
    return {
      endpoint: "/apply-template",
      body: withModel(
        {
          messages: [
            ...(systemPrompt
              ? [{ role: "system", content: systemPrompt }]
              : []),
            { role: "user", content: input.prompt },
          ],
        },
        input.model,
      ),
    };
  }

  if (input.kind === "embeddings") {
    return {
      endpoint: "/v1/embeddings",
      body: withModel(
        {
          input: input.prompt,
          encoding_format: "float",
        },
        input.model,
      ),
    };
  }

  if (input.kind === "rerank") {
    return {
      endpoint: "/v1/rerank",
      body: withModel(
        {
          query: input.prompt,
          documents: input.documents ?? [],
          top_n: input.documents?.length ?? 0,
        },
        input.model,
      ),
    };
  }

  if (input.kind === "completion") {
    return {
      endpoint: "/v1/completions",
      body: withModel(
        {
          prompt: input.prompt,
          max_tokens: input.maxTokens,
          temperature: input.temperature,
          stream: options.stream ?? false,
        },
        input.model,
      ),
    };
  }

  if (input.kind === "infill") {
    return {
      endpoint: "/infill",
      body: withModel(
        {
          input_prefix: input.inputPrefix ?? "",
          prompt: input.prompt,
          input_suffix: input.inputSuffix ?? "",
          n_predict: input.maxTokens,
          temperature: input.temperature,
          stream: options.stream ?? false,
        },
        input.model,
      ),
    };
  }

  if (input.kind === "responses") {
    return {
      endpoint: "/v1/responses",
      body: withModel(
        {
          ...(systemPrompt ? { instructions: systemPrompt } : {}),
          input: input.prompt,
          max_output_tokens: input.maxTokens,
          temperature: input.temperature,
          stream: options.stream ?? false,
        },
        input.model,
      ),
    };
  }

  return {
    endpoint: "/v1/chat/completions",
    body: withModel(
      {
        messages: [
          ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
          { role: "user", content: input.prompt },
        ],
        max_tokens: input.maxTokens,
        temperature: input.temperature,
        stream: options.stream ?? false,
      },
      input.model,
    ),
  };
}

export function instanceApiProbeTarget(
  instance: Instance,
  input: ApiProbeRequest,
  options: { stream?: boolean } = {},
) {
  const baseUrl = instanceBaseUrl(instance);
  if (!baseUrl) {
    throw new Error("UNIX socket API probes are not implemented yet");
  }

  return apiProbeTargetFromBaseUrl(baseUrl, input, options);
}

export function apiProbeTargetFromBaseUrl(
  baseUrl: string,
  input: ApiProbeRequest,
  options: { stream?: boolean } = {},
) {
  const { endpoint, body } = buildApiProbeRequestBody(input, options);
  const endpointWithQuery = endpointWithAutoload(endpoint, input.autoload);

  return {
    endpoint: endpointWithQuery,
    requestBody: body,
    url: `${baseUrl}${endpointWithQuery}`,
  };
}
