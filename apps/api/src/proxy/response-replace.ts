import type { ApiProxyTextReplacementRule } from "@arriero/core";

import type { ApiProxyReplaceResponseTextEffect } from "./pipeline.js";
import type { ApiProxyProtocolOperation } from "./protocol.js";
import {
  createApiProxySseFrameBuffer,
  createApiProxySseTransform,
  mutateApiProxyJsonText,
  mutateApiProxySseJsonFrame,
  type ApiProxySseFrameTransformer,
} from "./response-codec.js";

type JsonRecord = Record<string, unknown>;

type Replacement = {
  text: string;
  count: number;
};

type MutableDelta = {
  lane: string;
  text: string;
  set: (text: string) => void;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function activeRules(
  rules: ApiProxyTextReplacementRule[],
): ApiProxyTextReplacementRule[] {
  return rules.filter((rule) => rule.enabled && rule.find.length > 0);
}

export function replaceLiteralText(
  text: string,
  rules: ApiProxyTextReplacementRule[],
): Replacement {
  let next = text;
  let count = 0;
  for (const rule of activeRules(rules)) {
    const parts = next.split(rule.find);
    if (parts.length <= 1) {
      continue;
    }
    count += parts.length - 1;
    next = parts.join(rule.replace);
  }
  return { text: next, count };
}

function replaceStringField(
  record: JsonRecord,
  key: string,
  rules: ApiProxyTextReplacementRule[],
): number {
  const value = record[key];
  if (typeof value !== "string") {
    return 0;
  }
  const replacement = replaceLiteralText(value, rules);
  if (replacement.count > 0) {
    record[key] = replacement.text;
  }
  return replacement.count;
}

function replaceNestedStrings(
  value: unknown,
  rules: ApiProxyTextReplacementRule[],
): { value: unknown; count: number } {
  if (typeof value === "string") {
    const replacement = replaceLiteralText(value, rules);
    return { value: replacement.text, count: replacement.count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    value.forEach((item, index) => {
      const replacement = replaceNestedStrings(item, rules);
      value[index] = replacement.value;
      count += replacement.count;
    });
    return { value, count };
  }
  if (isRecord(value)) {
    let count = 0;
    for (const [key, item] of Object.entries(value)) {
      const replacement = replaceNestedStrings(item, rules);
      value[key] = replacement.value;
      count += replacement.count;
    }
    return { value, count };
  }
  return { value, count: 0 };
}

function replaceTextContent(
  owner: JsonRecord,
  key: string,
  rules: ApiProxyTextReplacementRule[],
): number {
  const content = owner[key];
  if (typeof content === "string") {
    return replaceStringField(owner, key, rules);
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let count = 0;
  for (const part of content) {
    if (!isRecord(part)) {
      continue;
    }
    const type = typeof part.type === "string" ? part.type : "";
    if (type === "text" || type === "output_text" || type === "summary_text") {
      count += replaceStringField(part, "text", rules);
    }
  }
  return count;
}

function replaceOpenAiChoices(
  body: JsonRecord,
  effect: ApiProxyReplaceResponseTextEffect,
): number {
  if (!Array.isArray(body.choices)) {
    return 0;
  }
  let count = 0;
  for (const choice of body.choices) {
    if (!isRecord(choice)) {
      continue;
    }
    count += replaceStringField(choice, "text", effect.rules);
    if (!isRecord(choice.message)) {
      continue;
    }
    const message = choice.message;
    count += replaceTextContent(message, "content", effect.rules);
    if (effect.includeReasoning) {
      count += replaceStringField(message, "reasoning_content", effect.rules);
      count += replaceStringField(message, "reasoning", effect.rules);
      count += replaceStringField(message, "reasoning_text", effect.rules);
    }
    if (effect.includeToolArguments && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (isRecord(toolCall) && isRecord(toolCall.function)) {
          count += replaceStringField(
            toolCall.function,
            "arguments",
            effect.rules,
          );
        }
      }
    }
  }
  return count;
}

function replaceAnthropicContent(
  body: JsonRecord,
  effect: ApiProxyReplaceResponseTextEffect,
): number {
  if (!Array.isArray(body.content)) {
    return 0;
  }
  let count = 0;
  for (const block of body.content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text") {
      count += replaceStringField(block, "text", effect.rules);
    } else if (block.type === "thinking" && effect.includeReasoning) {
      count += replaceStringField(block, "thinking", effect.rules);
    } else if (block.type === "tool_use" && effect.includeToolArguments) {
      const replacement = replaceNestedStrings(block.input, effect.rules);
      block.input = replacement.value;
      count += replacement.count;
    }
  }
  return count;
}

function replaceOpenAiResponsesOutput(
  body: JsonRecord,
  effect: ApiProxyReplaceResponseTextEffect,
): number {
  let count = replaceStringField(body, "output_text", effect.rules);
  if (!Array.isArray(body.output)) {
    return count;
  }
  for (const item of body.output) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.type === "message") {
      count += replaceTextContent(item, "content", effect.rules);
    } else if (item.type === "reasoning" && effect.includeReasoning) {
      count += replaceTextContent(item, "summary", effect.rules);
      count += replaceTextContent(item, "content", effect.rules);
    } else if (item.type === "function_call" && effect.includeToolArguments) {
      count += replaceStringField(item, "arguments", effect.rules);
    }
  }
  return count;
}

function replaceResponseObject(
  value: unknown,
  operation: ApiProxyProtocolOperation,
  effect: ApiProxyReplaceResponseTextEffect,
): number {
  if (!isRecord(value)) {
    return 0;
  }
  if (operation.protocol === "anthropic") {
    return replaceAnthropicContent(value, effect);
  }
  if (operation.endpoint === "responses") {
    return replaceOpenAiResponsesOutput(value, effect);
  }
  return replaceOpenAiChoices(value, effect);
}

export function replaceApiProxyResponseText(input: {
  text: string;
  operation: ApiProxyProtocolOperation;
  effect: ApiProxyReplaceResponseTextEffect;
}): Replacement {
  let count = 0;
  const mutation = mutateApiProxyJsonText(input.text, (value) => {
    count = replaceResponseObject(value, input.operation, input.effect);
    return { changed: count > 0, value };
  });
  return { text: mutation.text, count };
}

class StreamingLiteralRule {
  private pending = "";

  constructor(
    private readonly find: string,
    private readonly replace: string,
    private readonly onReplacement: () => void,
  ) {}

  push(text: string): string {
    this.pending += text;
    let output = "";
    for (;;) {
      const match = this.pending.indexOf(this.find);
      if (match >= 0) {
        output += this.pending.slice(0, match) + this.replace;
        this.pending = this.pending.slice(match + this.find.length);
        this.onReplacement();
        continue;
      }

      let keep = Math.min(this.find.length - 1, this.pending.length);
      while (keep > 0 && !this.find.startsWith(this.pending.slice(-keep))) {
        keep -= 1;
      }
      output += this.pending.slice(0, this.pending.length - keep);
      this.pending = this.pending.slice(this.pending.length - keep);
      return output;
    }
  }

  flush(): string {
    const output = this.pending;
    this.pending = "";
    return output;
  }
}

class StreamingLiteralChain {
  private readonly rules: StreamingLiteralRule[];

  constructor(rules: ApiProxyTextReplacementRule[], onReplacement: () => void) {
    this.rules = activeRules(rules).map(
      (rule) =>
        new StreamingLiteralRule(rule.find, rule.replace, onReplacement),
    );
  }

  push(text: string): string {
    return this.rules.reduce((value, rule) => rule.push(value), text);
  }

  flush(): string {
    let output = "";
    for (let index = 0; index < this.rules.length; index += 1) {
      let current = this.rules[index]?.flush() ?? "";
      for (let next = index + 1; next < this.rules.length; next += 1) {
        current = this.rules[next]?.push(current) ?? current;
      }
      output += current;
    }
    return output;
  }
}

function addStringDelta(
  deltas: MutableDelta[],
  owner: JsonRecord,
  key: string,
  lane: string,
): void {
  const text = owner[key];
  if (typeof text !== "string" || text.length === 0) {
    return;
  }
  deltas.push({
    lane,
    text,
    set: (next) => {
      owner[key] = next;
    },
  });
}

function collectOpenAiChoiceDeltas(
  value: JsonRecord,
  effect: ApiProxyReplaceResponseTextEffect,
): MutableDelta[] {
  const deltas: MutableDelta[] = [];
  if (!Array.isArray(value.choices)) {
    return deltas;
  }
  value.choices.forEach((choice, arrayIndex) => {
    if (!isRecord(choice)) {
      return;
    }
    const choiceIndex =
      typeof choice.index === "number" ? choice.index : arrayIndex;
    addStringDelta(deltas, choice, "text", `answer:choice:${choiceIndex}`);
    if (!isRecord(choice.delta)) {
      return;
    }
    const delta = choice.delta;
    addStringDelta(deltas, delta, "content", `answer:choice:${choiceIndex}`);
    if (effect.includeReasoning) {
      for (const key of ["reasoning_content", "reasoning", "reasoning_text"]) {
        addStringDelta(deltas, delta, key, `reasoning:choice:${choiceIndex}`);
      }
    }
    if (effect.includeToolArguments && Array.isArray(delta.tool_calls)) {
      delta.tool_calls.forEach((toolCall, toolArrayIndex) => {
        if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
          return;
        }
        const toolIndex =
          typeof toolCall.index === "number" ? toolCall.index : toolArrayIndex;
        addStringDelta(
          deltas,
          toolCall.function,
          "arguments",
          `tool:choice:${choiceIndex}:${toolIndex}`,
        );
      });
    }
  });
  return deltas;
}

function collectAnthropicDeltas(
  value: JsonRecord,
  effect: ApiProxyReplaceResponseTextEffect,
): MutableDelta[] {
  const deltas: MutableDelta[] = [];
  const index = typeof value.index === "number" ? value.index : 0;
  if (value.type === "content_block_start" && isRecord(value.content_block)) {
    const block = value.content_block;
    if (block.type === "text") {
      addStringDelta(deltas, block, "text", `answer:anthropic:${index}`);
    } else if (block.type === "thinking" && effect.includeReasoning) {
      addStringDelta(deltas, block, "thinking", `reasoning:anthropic:${index}`);
    }
  }
  if (value.type !== "content_block_delta" || !isRecord(value.delta)) {
    return deltas;
  }
  const delta = value.delta;
  if (delta.type === "text_delta") {
    addStringDelta(deltas, delta, "text", `answer:anthropic:${index}`);
  } else if (delta.type === "thinking_delta" && effect.includeReasoning) {
    addStringDelta(deltas, delta, "thinking", `reasoning:anthropic:${index}`);
  } else if (delta.type === "input_json_delta" && effect.includeToolArguments) {
    addStringDelta(deltas, delta, "partial_json", `tool:anthropic:${index}`);
  }
  return deltas;
}

function collectOpenAiResponsesDeltas(
  value: JsonRecord,
  effect: ApiProxyReplaceResponseTextEffect,
): MutableDelta[] {
  const deltas: MutableDelta[] = [];
  const type = typeof value.type === "string" ? value.type : "";
  const identity = [value.item_id, value.output_index, value.content_index]
    .filter((part) => typeof part === "string" || typeof part === "number")
    .join(":");
  if (type === "response.output_text.delta") {
    addStringDelta(deltas, value, "delta", `answer:responses:${identity}`);
  } else if (
    effect.includeReasoning &&
    (type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_text.delta")
  ) {
    addStringDelta(deltas, value, "delta", `reasoning:responses:${identity}`);
  } else if (
    effect.includeToolArguments &&
    type === "response.function_call_arguments.delta"
  ) {
    addStringDelta(deltas, value, "delta", `tool:responses:${identity}`);
  }
  return deltas;
}

function collectMutableDeltas(
  value: unknown,
  operation: ApiProxyProtocolOperation,
  effect: ApiProxyReplaceResponseTextEffect,
): MutableDelta[] {
  if (!isRecord(value)) {
    return [];
  }
  if (operation.protocol === "anthropic") {
    return collectAnthropicDeltas(value, effect);
  }
  if (operation.endpoint === "responses") {
    return collectOpenAiResponsesDeltas(value, effect);
  }
  return collectOpenAiChoiceDeltas(value, effect);
}

function frameHasDone(frame: string): boolean {
  return /(?:^|[\r\n])\uFEFF?[\t ]*data[\t ]*:[\t ]*\[DONE\][\t ]*(?=$|[\r\n])/.test(
    frame,
  );
}

function responseFinishesAllLanes(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (
    Array.isArray(value.choices) &&
    value.choices.some(
      (choice) => isRecord(choice) && choice.finish_reason != null,
    )
  ) {
    return true;
  }
  const type = typeof value.type === "string" ? value.type : "";
  return (
    type === "message_stop" ||
    (type === "message_delta" &&
      isRecord(value.delta) &&
      value.delta.stop_reason != null) ||
    type.endsWith(".done") ||
    type === "response.completed" ||
    type === "response.failed" ||
    type === "response.incomplete"
  );
}

function anthropicFinishedLanePrefixes(value: unknown): string[] {
  if (
    !isRecord(value) ||
    value.type !== "content_block_stop" ||
    typeof value.index !== "number"
  ) {
    return [];
  }
  return [
    `answer:anthropic:${value.index}`,
    `reasoning:anthropic:${value.index}`,
    `tool:anthropic:${value.index}`,
  ];
}

type LaneState = {
  chain: StreamingLiteralChain;
  template: ((text: string) => string | null) | null;
};

type ResponseReplaceStreamInput = {
  operation: ApiProxyProtocolOperation;
  effect: ApiProxyReplaceResponseTextEffect;
  onReplacement?: ((count: number) => void) | undefined;
};

function createResponseReplaceFrameTransformer(
  input: ResponseReplaceStreamInput,
): ApiProxySseFrameTransformer {
  const lanes = new Map<string, LaneState>();
  const onReplacement = () => input.onReplacement?.(1);

  const templateFor = (frame: string, lane: string) => (text: string) => {
    const mutation = mutateApiProxySseJsonFrame(frame, (value) => {
      const deltas = collectMutableDeltas(value, input.operation, input.effect);
      const target = deltas.find((delta) => delta.lane === lane);
      if (!target) {
        return { changed: false, value };
      }
      for (const delta of deltas) {
        delta.set(delta === target ? text : "");
      }
      return { changed: true, value };
    });
    return mutation.changed ? mutation.text : null;
  };

  const flushLane = (lane: string, state: LaneState): string | null => {
    const text = state.chain.flush();
    lanes.delete(lane);
    return text && state.template ? state.template(text) : null;
  };

  const flushMatching = (
    finishAll: boolean,
    finishedLanes: Set<string>,
    presentLanes: Set<string>,
  ) => {
    const output: string[] = [];
    for (const [lane, state] of lanes) {
      const finishes = finishAll || finishedLanes.has(lane);
      if (!finishes || presentLanes.has(lane)) {
        continue;
      }
      const frame = flushLane(lane, state);
      if (frame) {
        output.push(frame);
      }
    }
    return output;
  };

  const transformFrame = (frame: string): string[] => {
    let finishAll = frameHasDone(frame);
    const finishedLanes = new Set<string>();
    const presentLanes = new Set<string>();
    mutateApiProxySseJsonFrame(frame, (value) => {
      finishAll ||= responseFinishesAllLanes(value);
      for (const lane of anthropicFinishedLanePrefixes(value)) {
        finishedLanes.add(lane);
      }
      for (const delta of collectMutableDeltas(
        value,
        input.operation,
        input.effect,
      )) {
        presentLanes.add(delta.lane);
      }
      return { changed: false, value };
    });

    const output = flushMatching(finishAll, finishedLanes, presentLanes);
    const mutation = mutateApiProxySseJsonFrame(frame, (value) => {
      const deltas = collectMutableDeltas(value, input.operation, input.effect);
      let changed = false;
      for (const delta of deltas) {
        let state = lanes.get(delta.lane);
        if (!state) {
          state = {
            chain: new StreamingLiteralChain(input.effect.rules, onReplacement),
            template: null,
          };
          lanes.set(delta.lane, state);
        }
        state.template = templateFor(frame, delta.lane);
        let text = state.chain.push(delta.text);
        if (finishAll || finishedLanes.has(delta.lane)) {
          text += state.chain.flush();
          lanes.delete(delta.lane);
        }
        if (text !== delta.text) {
          delta.set(text);
          changed = true;
        }
      }
      return { changed, value };
    });
    output.push(mutation.text);
    return output;
  };

  return {
    transform: transformFrame,
    flush: () => {
      const output: string[] = [];
      for (const [lane, state] of [...lanes]) {
        const frame = flushLane(lane, state);
        if (frame) {
          output.push(frame);
        }
      }
      return output;
    },
  };
}

export function createApiProxyResponseReplaceStream(
  input: ResponseReplaceStreamInput,
): TransformStream<Uint8Array, Uint8Array> {
  return createApiProxySseTransform(
    createResponseReplaceFrameTransformer(input),
  );
}

function appendFrameOutput(
  output: string[],
  value: string | string[] | null,
): void {
  if (value === null) {
    return;
  }
  output.push(...(Array.isArray(value) ? value : [value]));
}

export function replaceApiProxyResponseSseText(input: {
  text: string;
  operation: ApiProxyProtocolOperation;
  effect: ApiProxyReplaceResponseTextEffect;
}): Replacement {
  let count = 0;
  const transformer = createResponseReplaceFrameTransformer({
    operation: input.operation,
    effect: input.effect,
    onReplacement: (increment) => {
      count += increment;
    },
  });
  const frames = createApiProxySseFrameBuffer();
  const output: string[] = [];
  for (const frame of frames.push(new TextEncoder().encode(input.text))) {
    appendFrameOutput(output, transformer.transform(frame));
  }
  const tail = frames.flush();
  if (tail !== null) {
    appendFrameOutput(output, transformer.transform(tail));
  }
  if (transformer.flush) {
    appendFrameOutput(output, transformer.flush());
  }
  return { text: output.join(""), count };
}
