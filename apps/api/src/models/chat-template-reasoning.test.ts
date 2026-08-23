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

const deepseekV4Snippet = `
{%- if not reasoning_effort is defined -%}
  {%- set reasoning_effort = none -%}
{%- endif -%}
{%- set reasoning_effort_high = 'Reasoning Effort: Absolute maximum.' -%}
{%- set reasoning_effort_max = 'Reasoning Effort: Beyond maximum.' -%}
{%- if thinking -%}
  {%- if reasoning_effort == 'high' -%}
    {{- reasoning_effort_high -}}
  {%- elif reasoning_effort == 'max' -%}
    {{- reasoning_effort_max -}}
  {%- endif -%}
{%- endif -%}
{%- if enable_thinking is defined -%}{%- endif -%}
`;

test("extracts the Qwen3.8 effort ladder and alias from the template", () => {
  const detection = extractChatTemplateReasoning(qwen38Snippet);
  assert.ok(detection);
  assert.equal(detection.usesReasoningEffort, true);
  assert.equal(detection.usesEnableThinking, true);
  assert.deepEqual(detection.levels, ["xhigh", "medium", "low"]);
  assert.deepEqual(detection.aliases, { high: "xhigh" });
  assert.equal(detection.strict, true);
});

test("extracts a tolerant ladder from DeepSeek-style equality chains", () => {
  const detection = extractChatTemplateReasoning(deepseekV4Snippet);
  assert.ok(detection);
  assert.equal(detection.usesReasoningEffort, true);
  assert.equal(detection.usesEnableThinking, true);
  assert.deepEqual(detection.levels, ["high", "max"]);
  assert.equal(detection.aliases, null);
  assert.equal(detection.strict, false);
});

test("equality-chain fallback skips alias sources and single-level ladders", () => {
  const detection = extractChatTemplateReasoning(`
{%- if reasoning_effort == 'high' %}{%- set reasoning_effort = 'xhigh' %}{%- endif %}
{%- if reasoning_effort == 'xhigh' %}{{ 'think hard' }}{%- endif %}
`);
  assert.ok(detection);
  assert.equal(detection.levels, null);
  assert.deepEqual(detection.aliases, { high: "xhigh" });
});

test("a raise_exception far from the effort logic stays tolerant", () => {
  const filler = "{{ '.' }}".repeat(80);
  const detection = extractChatTemplateReasoning(`
{%- if reasoning_effort == 'high' -%}{{ 'deep' }}{%- elif reasoning_effort == 'max' -%}{{ 'deeper' }}{%- endif -%}
${filler}
{%- if messages | length == 0 -%}{{- raise_exception('empty conversation') -}}{%- endif -%}
`);
  assert.ok(detection);
  assert.deepEqual(detection.levels, ["high", "max"]);
  assert.equal(detection.strict, false);
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
  assert.equal(detection.strict, false);
});

test("returns null without a chat template", () => {
  assert.equal(extractChatTemplateReasoning(null), null);
});
