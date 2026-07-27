import type {
  ApiLabProbeProfile,
  ApiProbeRequest,
  ApiProbeResult,
} from "@arriero/core";

import { requestJsonProbe } from "../instances/endpoint.js";

const API_LAB_PROBE_TIMEOUT_MS = 10 * 60 * 1_000;

function compactOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

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

function openAiApiProbeRequestBody(
  input: ApiProbeRequest,
  options: { stream?: boolean } = {},
) {
  const systemPrompt = compactOptionalString(input.systemPrompt);

  if (input.kind === "embeddings") {
    return {
      endpoint: "/embeddings",
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
      endpoint: "/rerank",
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
      endpoint: "/completions",
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

  if (input.kind === "responses") {
    return {
      endpoint: "/responses",
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
    endpoint: "/chat/completions",
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

function llamaNativeApiProbeRequestBody(
  input: ApiProbeRequest,
  options: { stream?: boolean } = {},
) {
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

function anthropicApiProbeRequestBody(
  input: ApiProbeRequest,
  options: { stream?: boolean } = {},
) {
  const systemPrompt = compactOptionalString(input.systemPrompt);

  if (input.kind === "count-tokens") {
    return {
      endpoint: "/messages/count_tokens",
      body: withModel(
        {
          ...(systemPrompt ? { system: systemPrompt } : {}),
          messages: [{ role: "user", content: input.prompt }],
        },
        input.model,
      ),
    };
  }

  return {
    endpoint: "/messages",
    body: withModel(
      {
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: [{ role: "user", content: input.prompt }],
        max_tokens: input.maxTokens,
        temperature: input.temperature,
        stream: options.stream ?? false,
      },
      input.model,
    ),
  };
}

export function apiLabProbeTargetFromBaseUrl(
  profile: ApiLabProbeProfile,
  baseUrl: string,
  input: ApiProbeRequest,
  options: { stream?: boolean } = {},
) {
  const { endpoint, body } =
    profile === "openai"
      ? openAiApiProbeRequestBody(input, options)
      : profile === "llama-native"
        ? llamaNativeApiProbeRequestBody(input, options)
        : anthropicApiProbeRequestBody(input, options);
  const endpointWithQuery =
    profile === "llama-native"
      ? endpointWithAutoload(endpoint, input.autoload)
      : endpoint;

  return {
    endpoint: endpointWithQuery,
    requestBody: body,
    url: `${baseUrl}${endpointWithQuery}`,
  };
}

export async function requestApiLabProbeBaseUrl(
  profile: ApiLabProbeProfile,
  baseUrl: string,
  input: ApiProbeRequest,
  headers: Record<string, string> = {},
): Promise<ApiProbeResult> {
  const target = apiLabProbeTargetFromBaseUrl(profile, baseUrl, input);

  return {
    profile,
    kind: input.kind,
    endpoint: target.endpoint,
    requestBody: target.requestBody,
    response: await requestJsonProbe(target.url, {
      method: "POST",
      body: JSON.stringify(target.requestBody),
      headers: { "content-type": "application/json", ...headers },
      timeoutMs: API_LAB_PROBE_TIMEOUT_MS,
    }),
  };
}
