import type { ApiProxyConditionScope } from "@arriero/core";

type ApiProxyRequestMessage = {
  role: string | null;
  texts: string[];
};

function textsFromContent(content: unknown): string[] {
  if (typeof content === "string") {
    return content ? [content] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part) {
        texts.push(part);
      }
      continue;
    }
    if (part && typeof part === "object") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string" && text) {
        texts.push(text);
      }
    }
  }
  return texts;
}

function extractRequestMessages(
  body: unknown,
): ApiProxyRequestMessage[] {
  if (!body || typeof body !== "object") {
    return [];
  }
  const record = body as Record<string, unknown>;
  const messages: ApiProxyRequestMessage[] = [];

  const systemTexts = textsFromContent(record.system);
  if (systemTexts.length > 0) {
    messages.push({ role: "system", texts: systemTexts });
  }

  if (Array.isArray(record.messages)) {
    for (const message of record.messages) {
      if (!message || typeof message !== "object") {
        continue;
      }
      const item = message as Record<string, unknown>;
      messages.push({
        role: typeof item.role === "string" ? item.role : null,
        texts: textsFromContent(item.content),
      });
    }
  }

  const promptTexts = textsFromContent(record.prompt);
  if (promptTexts.length > 0) {
    messages.push({ role: "user", texts: promptTexts });
  }

  return messages;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

const systemRoles = new Set(["system", "developer"]);

export function requestScopeText(
  body: unknown,
  scope: ApiProxyConditionScope,
): string {
  if (scope === "full-body") {
    return safeStringify(body);
  }
  const messages = extractRequestMessages(body);
  if (scope === "any-message") {
    return messages.flatMap((message) => message.texts).join("\n");
  }
  if (scope === "system") {
    return messages
      .filter(
        (message) => message.role !== null && systemRoles.has(message.role),
      )
      .flatMap((message) => message.texts)
      .join("\n");
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return message.texts.join("\n");
    }
  }
  return "";
}

export function collectEstimatorTexts(body: unknown): {
  texts: string[];
  messageCount: number;
} {
  const messages = extractRequestMessages(body);
  const texts = messages.flatMap((message) => message.texts);
  if (body && typeof body === "object") {
    const tools = (body as { tools?: unknown }).tools;
    if (tools !== undefined) {
      texts.push(safeStringify(tools));
    }
  }
  if (texts.length === 0 && messages.length === 0) {
    return { texts: [safeStringify(body)], messageCount: 0 };
  }
  return { texts, messageCount: messages.length };
}
