import assert from "node:assert/strict";
import test from "node:test";

import { requestScopeText } from "./request-text.js";
import { estimateRequestTokens, estimateTextTokens } from "./token-estimate.js";

test("estimateTextTokens weighs latin, cyrillic and cjk text differently", () => {
  assert.equal(estimateTextTokens("hello world"), 3);
  assert.equal(estimateTextTokens("привет мир"), 5);
  assert.equal(estimateTextTokens("你好世界"), 4);
  assert.equal(estimateTextTokens(""), 0);
});

test("estimateRequestTokens sums message texts with per-message overhead", () => {
  const empty = estimateRequestTokens({
    model: "m",
    messages: [{ role: "user", content: "" }],
  });
  assert.deepEqual(empty, { tokens: 4, imageCount: 0 });

  const tokens = estimateRequestTokens({
    model: "m",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "hello world" }] },
    ],
  });
  assert.equal(tokens.tokens, 8 + estimateTextTokens("be brief") + 3);
});

test("estimateRequestTokens counts anthropic system and tools", () => {
  const withoutTools = estimateRequestTokens({
    model: "m",
    system: "be brief",
    messages: [{ role: "user", content: "hello" }],
  });
  const withTools = estimateRequestTokens({
    model: "m",
    system: "be brief",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "search", description: "web search" }],
  });
  assert.ok(withTools.tokens > withoutTools.tokens);
});

test("estimateRequestTokens falls back to the serialized body", () => {
  assert.ok(estimateRequestTokens({ input: "some plain payload" }).tokens > 0);
});

test("agent history retains its text estimate across Anthropic and OpenAI representations", () => {
  const text = "agent history ".repeat(30_000);
  const baseline = estimateRequestTokens({
    messages: [{ role: "user", content: text }],
  }).tokens;
  for (const message of [
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call-1", content: text }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: [{ type: "text", text }],
        },
      ],
    },
    { role: "assistant", content: [{ type: "thinking", thinking: text }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call-1", name: "f", input: { text } }],
    },
    { role: "assistant", content: "", reasoning_content: text },
    { role: "assistant", content: "", reasoning: text },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "f", arguments: JSON.stringify({ text }) },
        },
      ],
    },
    {
      role: "assistant",
      function_call: { name: "f", arguments: JSON.stringify({ text }) },
    },
  ]) {
    assert.ok(
      estimateRequestTokens({ messages: [message] }).tokens >= baseline,
    );
  }
});

test("nested tool results count images separately without counting their encoding or thinking signatures", () => {
  const estimate = (encoding: string) =>
    estimateRequestTokens({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "consider", signature: encoding },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: [
                { type: "text", text: "screenshot result" },
                { type: "image", source: { type: "base64", data: encoding } },
                {
                  type: "tool_result",
                  content: [
                    { type: "image_url", image_url: { url: encoding } },
                  ],
                },
              ],
            },
            { type: "image", source: { type: "url", url: encoding } },
          ],
        },
      ],
    });
  const small = estimate("data:image/png;base64,AAA");
  assert.deepEqual(
    estimate("data:image/png;base64," + "A".repeat(900_000)),
    small,
  );
  assert.equal(small.imageCount, 3);
  assert.ok(small.tokens > 8);
});

test("estimator expansion preserves text-match scopes", () => {
  const body = {
    system: "system text",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "tool_use", name: "lookup", input: { q: "argument" } },
          { type: "text", text: "visible assistant" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", content: "tool output" },
          { type: "text", text: "visible user" },
        ],
      },
    ],
  };
  assert.equal(requestScopeText(body, "system"), "system text");
  assert.equal(requestScopeText(body, "last-user-message"), "visible user");
  assert.equal(
    requestScopeText(body, "any-message"),
    "system text\nvisible assistant\nvisible user",
  );
  assert.equal(requestScopeText(body, "full-body"), JSON.stringify(body));
});
