import {
  activeApiProxyTextReplacementRules,
  applyApiProxyTextReplacements,
  type ApiProxyTextReplacementRule,
} from "@arriero/core";

import { isRecord, type JsonRecord } from "./json.js";
import type { ApiProxyReplaceResponseTextEffect } from "./pipeline.js";
import {
  apiProxyResponseShape,
  type ApiProxyProtocolOperation,
} from "./protocol.js";
import {
  createApiProxySseTransform,
  mutateApiProxyJsonText,
  parseApiProxySseJsonFrame,
  transformApiProxySseText,
  type ApiProxySseFrameTransformer,
} from "./response-codec.js";

type Replacement = {
  text: string;
  count: number;
};

export type MutableDelta = {
  lane: string;
  text: string;
  set: (text: string) => void;
  flushFrame: (text: string) => string;
};

function replaceStringField(
  record: JsonRecord,
  key: string,
  rules: ApiProxyTextReplacementRule[],
): number {
  const value = record[key];
  if (typeof value !== "string") {
    return 0;
  }
  const replacement = applyApiProxyTextReplacements(value, rules);
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
    const replacement = applyApiProxyTextReplacements(value, rules);
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

function replaceOpenAiResponsesItem(
  item: JsonRecord,
  effect: ApiProxyReplaceResponseTextEffect,
): number {
  if (item.type === "message") {
    return replaceTextContent(item, "content", effect.rules);
  }
  if (item.type === "reasoning" && effect.includeReasoning) {
    return (
      replaceTextContent(item, "summary", effect.rules) +
      replaceTextContent(item, "content", effect.rules)
    );
  }
  if (item.type === "function_call" && effect.includeToolArguments) {
    return replaceStringField(item, "arguments", effect.rules);
  }
  return 0;
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
    if (isRecord(item)) {
      count += replaceOpenAiResponsesItem(item, effect);
    }
  }
  return count;
}

function replaceOpenAiResponsesAggregate(
  value: JsonRecord,
  effect: ApiProxyReplaceResponseTextEffect,
): number {
  const type = typeof value.type === "string" ? value.type : "";
  if (type === "response.output_text.done") {
    return replaceStringField(value, "text", effect.rules);
  }
  if (
    (type === "response.reasoning_summary_text.done" ||
      type === "response.reasoning_text.done") &&
    effect.includeReasoning
  ) {
    return replaceStringField(value, "text", effect.rules);
  }
  if (
    type === "response.function_call_arguments.done" &&
    effect.includeToolArguments
  ) {
    return replaceStringField(value, "arguments", effect.rules);
  }
  if (type === "response.output_item.done" && isRecord(value.item)) {
    return replaceOpenAiResponsesItem(value.item, effect);
  }
  if (type === "response.content_part.done" && isRecord(value.part)) {
    const part = value.part;
    if (
      part.type === "output_text" ||
      (part.type === "summary_text" && effect.includeReasoning)
    ) {
      return replaceStringField(part, "text", effect.rules);
    }
    return 0;
  }
  if (
    (type === "response.completed" ||
      type === "response.failed" ||
      type === "response.incomplete") &&
    isRecord(value.response)
  ) {
    return replaceOpenAiResponsesOutput(value.response, effect);
  }
  return 0;
}

function replaceResponseObject(
  value: unknown,
  operation: ApiProxyProtocolOperation,
  effect: ApiProxyReplaceResponseTextEffect,
): number {
  if (!isRecord(value)) {
    return 0;
  }
  switch (apiProxyResponseShape(operation)) {
    case "anthropic":
      return replaceAnthropicContent(value, effect);
    case "openai-responses":
      return replaceOpenAiResponsesOutput(value, effect);
    case "openai-chat":
      return replaceOpenAiChoices(value, effect);
  }
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
    this.rules = activeApiProxyTextReplacementRules(rules).map(
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
  flushFrame: (text: string) => string,
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
    flushFrame,
  });
}

function sseDataFrame(payload: JsonRecord): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
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
    addStringDelta(
      deltas,
      choice,
      "text",
      `answer:choice:${choiceIndex}`,
      (text) =>
        sseDataFrame({
          id: value.id,
          object: value.object,
          created: value.created,
          model: value.model,
          choices: [{ index: choiceIndex, text }],
        }),
    );
    if (!isRecord(choice.delta)) {
      return;
    }
    const delta = choice.delta;
    const deltaFrame = (deltaPayload: (text: string) => JsonRecord) => {
      return (text: string) =>
        sseDataFrame({
          id: value.id,
          object: value.object,
          created: value.created,
          model: value.model,
          choices: [{ index: choiceIndex, delta: deltaPayload(text) }],
        });
    };
    addStringDelta(
      deltas,
      delta,
      "content",
      `answer:choice:${choiceIndex}`,
      deltaFrame((text) => ({ content: text })),
    );
    if (effect.includeReasoning) {
      for (const key of ["reasoning_content", "reasoning", "reasoning_text"]) {
        addStringDelta(
          deltas,
          delta,
          key,
          `reasoning:choice:${choiceIndex}`,
          deltaFrame((text) => ({ [key]: text })),
        );
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
          deltaFrame((text) => ({
            tool_calls: [{ index: toolIndex, function: { arguments: text } }],
          })),
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
  const eventFrame =
    (delta: (text: string) => JsonRecord) => (text: string) => {
      const payload = {
        type: "content_block_delta",
        index,
        delta: delta(text),
      };
      return `event: content_block_delta\ndata: ${JSON.stringify(payload)}\n\n`;
    };
  const textFrame = eventFrame((text) => ({ type: "text_delta", text }));
  const thinkingFrame = eventFrame((text) => ({
    type: "thinking_delta",
    thinking: text,
  }));
  const toolFrame = eventFrame((text) => ({
    type: "input_json_delta",
    partial_json: text,
  }));
  if (value.type === "content_block_start" && isRecord(value.content_block)) {
    const block = value.content_block;
    if (block.type === "text") {
      addStringDelta(
        deltas,
        block,
        "text",
        `answer:anthropic:${index}`,
        textFrame,
      );
    } else if (block.type === "thinking" && effect.includeReasoning) {
      addStringDelta(
        deltas,
        block,
        "thinking",
        `reasoning:anthropic:${index}`,
        thinkingFrame,
      );
    }
  }
  if (value.type !== "content_block_delta" || !isRecord(value.delta)) {
    return deltas;
  }
  const delta = value.delta;
  if (delta.type === "text_delta") {
    addStringDelta(
      deltas,
      delta,
      "text",
      `answer:anthropic:${index}`,
      textFrame,
    );
  } else if (delta.type === "thinking_delta" && effect.includeReasoning) {
    addStringDelta(
      deltas,
      delta,
      "thinking",
      `reasoning:anthropic:${index}`,
      thinkingFrame,
    );
  } else if (delta.type === "input_json_delta" && effect.includeToolArguments) {
    addStringDelta(
      deltas,
      delta,
      "partial_json",
      `tool:anthropic:${index}`,
      toolFrame,
    );
  }
  return deltas;
}

function openAiResponsesIdentity(value: JsonRecord): string {
  return [value.item_id, value.output_index, value.content_index]
    .filter((part) => typeof part === "string" || typeof part === "number")
    .join(":");
}

function collectOpenAiResponsesDeltas(
  value: JsonRecord,
  effect: ApiProxyReplaceResponseTextEffect,
): MutableDelta[] {
  const deltas: MutableDelta[] = [];
  const type = typeof value.type === "string" ? value.type : "";
  const identity = openAiResponsesIdentity(value);
  const eventFrame = (eventType: string) => (text: string) => {
    const payload: JsonRecord = { type: eventType };
    for (const key of ["item_id", "output_index", "content_index"]) {
      if (value[key] !== undefined) {
        payload[key] = value[key];
      }
    }
    payload.delta = text;
    return sseDataFrame(payload);
  };
  if (type === "response.output_text.delta") {
    addStringDelta(
      deltas,
      value,
      "delta",
      `answer:responses:${identity}`,
      eventFrame(type),
    );
  } else if (
    effect.includeReasoning &&
    (type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_text.delta")
  ) {
    addStringDelta(
      deltas,
      value,
      "delta",
      `reasoning:responses:${identity}`,
      eventFrame(type),
    );
  } else if (
    effect.includeToolArguments &&
    type === "response.function_call_arguments.delta"
  ) {
    addStringDelta(
      deltas,
      value,
      "delta",
      `tool:responses:${identity}`,
      eventFrame(type),
    );
  }
  return deltas;
}

export function collectMutableDeltas(
  value: unknown,
  operation: ApiProxyProtocolOperation,
  effect: ApiProxyReplaceResponseTextEffect,
): MutableDelta[] {
  if (!isRecord(value)) {
    return [];
  }
  switch (apiProxyResponseShape(operation)) {
    case "anthropic":
      return collectAnthropicDeltas(value, effect);
    case "openai-responses":
      return collectOpenAiResponsesDeltas(value, effect);
    case "openai-chat":
      return collectOpenAiChoiceDeltas(value, effect);
  }
}

type LaneFinish = {
  finishAll: boolean;
  lanePrefixes: string[];
};

function laneFinishesForPayload(value: unknown): LaneFinish {
  if (!isRecord(value)) {
    return { finishAll: false, lanePrefixes: [] };
  }
  const lanePrefixes: string[] = [];
  if (Array.isArray(value.choices)) {
    value.choices.forEach((choice, arrayIndex) => {
      if (!isRecord(choice) || choice.finish_reason == null) {
        return;
      }
      const choiceIndex =
        typeof choice.index === "number" ? choice.index : arrayIndex;
      lanePrefixes.push(
        `answer:choice:${choiceIndex}`,
        `reasoning:choice:${choiceIndex}`,
        `tool:choice:${choiceIndex}`,
      );
    });
  }
  const type = typeof value.type === "string" ? value.type : "";
  if (
    type === "message_stop" ||
    (type === "message_delta" &&
      isRecord(value.delta) &&
      value.delta.stop_reason != null) ||
    type === "response.completed" ||
    type === "response.failed" ||
    type === "response.incomplete"
  ) {
    return { finishAll: true, lanePrefixes };
  }
  if (type === "content_block_stop" && typeof value.index === "number") {
    lanePrefixes.push(
      `answer:anthropic:${value.index}`,
      `reasoning:anthropic:${value.index}`,
      `tool:anthropic:${value.index}`,
    );
  }
  if (type.startsWith("response.") && type.endsWith(".done")) {
    const identity = openAiResponsesIdentity(value);
    const lane = (kind: string) =>
      identity ? `${kind}:responses:${identity}` : `${kind}:responses`;
    if (type === "response.output_text.done") {
      lanePrefixes.push(lane("answer"));
    } else if (
      type === "response.reasoning_summary_text.done" ||
      type === "response.reasoning_text.done"
    ) {
      lanePrefixes.push(lane("reasoning"));
    } else if (type === "response.function_call_arguments.done") {
      lanePrefixes.push(lane("tool"));
    } else {
      lanePrefixes.push(lane("answer"), lane("reasoning"), lane("tool"));
    }
  }
  return { finishAll: false, lanePrefixes };
}

type LaneState = {
  chain: StreamingLiteralChain;
  flushFrame: ((text: string) => string) | null;
};

type ResponseReplaceStreamInput = {
  operation: ApiProxyProtocolOperation;
  effect: ApiProxyReplaceResponseTextEffect;
  onReplacement?: ((count: number) => void) | undefined;
};

function jsonEscapedRules(
  rules: ApiProxyTextReplacementRule[],
): ApiProxyTextReplacementRule[] {
  return rules.map((rule) => ({
    ...rule,
    find: JSON.stringify(rule.find).slice(1, -1),
    replace: JSON.stringify(rule.replace).slice(1, -1),
  }));
}

function createResponseReplaceFrameTransformer(
  input: ResponseReplaceStreamInput,
): ApiProxySseFrameTransformer {
  const shape = apiProxyResponseShape(input.operation);
  const lanes = new Map<string, LaneState>();
  const onReplacement = () => input.onReplacement?.(1);

  let anthropicToolRules: ApiProxyTextReplacementRule[] | null = null;
  const rulesForLane = (lane: string): ApiProxyTextReplacementRule[] => {
    if (!lane.startsWith("tool:anthropic")) {
      return input.effect.rules;
    }
    anthropicToolRules ??= jsonEscapedRules(input.effect.rules);
    return anthropicToolRules;
  };

  const flushLane = (lane: string, state: LaneState): string | null => {
    const text = state.chain.flush();
    lanes.delete(lane);
    return text && state.flushFrame ? state.flushFrame(text) : null;
  };

  const laneFinishes = (
    lane: string,
    finishAll: boolean,
    finishedPrefixes: string[],
  ) =>
    finishAll ||
    finishedPrefixes.some(
      (prefix) => lane === prefix || lane.startsWith(`${prefix}:`),
    );

  const flushMatching = (
    finishAll: boolean,
    finishedPrefixes: string[],
    presentLanes: Set<string>,
  ) => {
    const output: string[] = [];
    for (const [lane, state] of [...lanes]) {
      if (
        !laneFinishes(lane, finishAll, finishedPrefixes) ||
        presentLanes.has(lane)
      ) {
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
    const parsed = parseApiProxySseJsonFrame(frame);
    let finishAll = parsed.hasDone;
    const finishedPrefixes: string[] = [];
    const presentLanes = new Set<string>();
    const payloadDeltas = parsed.payloads.map((payload) => {
      if (shape === "openai-responses" && isRecord(payload.value)) {
        const aggregate = replaceOpenAiResponsesAggregate(
          payload.value,
          input.effect,
        );
        if (aggregate > 0) {
          payload.replace(payload.value);
          input.onReplacement?.(aggregate);
        }
      }
      const finish = laneFinishesForPayload(payload.value);
      finishAll ||= finish.finishAll;
      finishedPrefixes.push(...finish.lanePrefixes);
      const deltas = collectMutableDeltas(
        payload.value,
        input.operation,
        input.effect,
      );
      for (const delta of deltas) {
        presentLanes.add(delta.lane);
      }
      return { payload, deltas };
    });

    const output = flushMatching(finishAll, finishedPrefixes, presentLanes);
    for (const { payload, deltas } of payloadDeltas) {
      for (const delta of deltas) {
        let state = lanes.get(delta.lane);
        if (!state) {
          state = {
            chain: new StreamingLiteralChain(
              rulesForLane(delta.lane),
              onReplacement,
            ),
            flushFrame: null,
          };
          lanes.set(delta.lane, state);
        }
        state.flushFrame = delta.flushFrame;
        let text = state.chain.push(delta.text);
        if (laneFinishes(delta.lane, finishAll, finishedPrefixes)) {
          text += state.chain.flush();
          lanes.delete(delta.lane);
        }
        if (text !== delta.text) {
          delta.set(text);
          payload.replace(payload.value);
        }
      }
    }
    output.push(parsed.serialize().text);
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
  return { text: transformApiProxySseText(input.text, transformer), count };
}
