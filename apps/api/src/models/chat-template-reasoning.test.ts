import assert from "node:assert/strict";
import test from "node:test";

import { extractChatTemplateReasoning } from "./chat-template-reasoning.js";

const qwen38Snippet = `
{%- if enable_thinking is undefined or enable_thinking is true %}
    {%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}
    {%- if resolved_reasoning_effort == 'high' %}
        {%- set resolved_reasoning_effort = 'xhigh' %}
    {%- endif %}
    {%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}
        {{- raise_exception('Unexpected reasoning effort ' ~ reasoning_effort ~ '. Supported types are xhigh (default), medium, and low.') }}
    {%- endif %}
{%- endif %}
`;

test("extracts the Qwen3.8 effort ladder and alias from the template", () => {
  const detection = extractChatTemplateReasoning(qwen38Snippet);
  assert.ok(detection);
  assert.equal(detection.usesReasoningEffort, true);
  assert.equal(detection.usesEnableThinking, true);
  assert.deepEqual(detection.levels, ["xhigh", "medium", "low"]);
  assert.deepEqual(detection.aliases, { high: "xhigh" });
});

test("reports plain enable_thinking templates without inventing a ladder", () => {
  const detection = extractChatTemplateReasoning(
    "{%- if enable_thinking is defined and enable_thinking is false %}{%- endif %}",
  );
  assert.ok(detection);
  assert.equal(detection.usesReasoningEffort, false);
  assert.equal(detection.usesEnableThinking, true);
  assert.equal(detection.levels, null);
  assert.equal(detection.aliases, null);
});

test("keeps the ladder null when the convention is absent", () => {
  const detection = extractChatTemplateReasoning(
    "{{ reasoning_effort|default('medium') }}",
  );
  assert.ok(detection);
  assert.equal(detection.usesReasoningEffort, true);
  assert.equal(detection.levels, null);
});

test("returns null without a chat template", () => {
  assert.equal(extractChatTemplateReasoning(null), null);
});
