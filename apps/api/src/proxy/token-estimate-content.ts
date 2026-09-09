import { asObject } from "./json.js";

type EstimatorContent = {
  texts: string[];
  messageCount: number;
  imageCount: number;
};

function appendText(value: unknown, result: EstimatorContent) {
  if (typeof value === "string" && value) result.texts.push(value);
}

function collectContent(content: unknown, result: EstimatorContent) {
  const pending = [content];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      appendText(value, result);
      continue;
    }
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push(value[index]);
      }
      continue;
    }
    const part = asObject(value);
    if (!part) continue;
    switch (part.type) {
      case "text":
        appendText(part.text, result);
        break;
      case "tool_result":
        pending.push(part.content);
        break;
      case "thinking":
        appendText(part.thinking, result);
        break;
      case "tool_use":
        appendText(part.name, result);
        appendText(JSON.stringify(part.input ?? {}), result);
        break;
      case "image":
      case "image_url":
        result.imageCount += 1;
        break;
    }
  }
}

export function collectEstimatorContent(body: unknown): EstimatorContent {
  const result: EstimatorContent = {
    texts: [],
    messageCount: 0,
    imageCount: 0,
  };
  const record = asObject(body);
  collectContent(record?.system, result);
  if (result.texts.length > 0) result.messageCount += 1;

  if (Array.isArray(record?.messages)) {
    for (const value of record.messages) {
      const message = asObject(value);
      if (!message) continue;
      result.messageCount += 1;
      collectContent(message.content, result);
      appendText(message.reasoning_content ?? message.reasoning, result);
      appendText(message.name, result);
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const call of calls) {
        const fn = asObject(asObject(call)?.function);
        appendText(fn?.name, result);
        appendText(fn?.arguments, result);
      }
      const fn = asObject(message.function_call);
      appendText(fn?.name, result);
      appendText(fn?.arguments, result);
    }
  }

  const previousTextCount = result.texts.length;
  collectContent(record?.prompt, result);
  if (result.texts.length > previousTextCount) result.messageCount += 1;
  appendText(JSON.stringify(record?.tools), result);
  appendText(JSON.stringify(record?.functions), result);
  if (
    result.texts.length === 0 &&
    result.messageCount === 0 &&
    result.imageCount === 0
  ) {
    appendText(JSON.stringify(body), result);
  }
  return result;
}
