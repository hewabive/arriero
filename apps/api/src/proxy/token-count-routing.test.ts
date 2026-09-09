import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiProxyModelRecordSchema,
  ApiProxyPipelineRecordSchema,
  defaultApiProxyTokenCountConfig,
  type ApiProxyPipelineRecord,
} from "@arriero/core";

import { resolveApiProxyRouteChain } from "./pipeline.js";
import {
  collectApiProxyPipelineRefs,
  validateApiProxyPipelineGraph,
} from "./pipeline-validation.js";
import type { ApiProxyProtocolModelRequest } from "./protocol.js";
import type { ApiProxyTokenCounter } from "./token-count.js";

const targetA = { type: "target", id: "A" };
const targetB = { type: "target", id: "B" };
const nodeRef = (id: string) => ({ type: "node", id });

function graph(nodes: unknown[], id = "p", entry = nodeRef("limit")) {
  return ApiProxyPipelineRecordSchema.parse({
    id,
    name: id,
    enabled: true,
    entry,
    nodes,
  });
}

function limit(next: unknown, tokenCount?: unknown, id = "limit") {
  return {
    id,
    type: "context-limit",
    config: { thresholdTokens: 100, tokenCount },
    ports: { next },
  };
}

function sizeCondition(tokenCount?: unknown) {
  return {
    id: "limit",
    type: "condition",
    config: {
      predicate: { type: "token-estimate", minTokens: 100, tokenCount },
    },
    ports: { false: targetA, true: targetB },
  };
}

function run(
  pipelines: ApiProxyPipelineRecord[],
  countTokens: ApiProxyTokenCounter,
  body: unknown = {
    model: "public",
    messages: [{ role: "user", content: "hello" }],
  },
  protocol: "openai" | "anthropic" = "openai",
) {
  const request: ApiProxyProtocolModelRequest = {
    operation: {
      protocol,
      endpoint: protocol === "anthropic" ? "messages" : "chat.completions",
      routePath:
        protocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions",
      transport: "http-json",
    },
    body,
    modelId: "public",
    model: ApiProxyModelRecordSchema.parse({
      id: "m",
      modelId: "public",
      routeTo: { type: "pipeline", id: "p" },
    }),
    stream: false,
  };
  return resolveApiProxyRouteChain({
    request,
    countTokens,
    getPipeline: (id) => pipelines.find((p) => p.id === id) ?? null,
  });
}

test("single target exact count rejects a prompt underestimated locally, including equality", async () => {
  const calls: string[] = [];
  const result = await run([graph([limit(targetA)])], async (_, targetId) => {
    calls.push(targetId);
    return { ok: true, tokens: 100, detail: "exact 100 tokens for A" };
  });
  assert.deepEqual(calls, ["A"]);
  assert.ok(!result.ok);
  assert.equal(result.diagnostic.code, "arriero_proxy_context_overflow");
  assert.match(result.routeTrace.at(-1)?.detail ?? "", /exact 100.*rejected/);
});

test("overflow routing counts only A even when selecting B", async () => {
  const calls: string[] = [];
  const result = await run(
    [graph([sizeCondition({ targetId: "A" })])],
    async (_, targetId) => {
      calls.push(targetId);
      return { ok: true, tokens: 120, detail: "exact 120 tokens for A" };
    },
  );
  assert.deepEqual(calls, ["A"]);
  assert.ok(result.ok && result.kind === "target");
  assert.equal(result.targetId, "B");
});

test("ambiguous auto target has explicit fallback and strict mode never guesses", async () => {
  const counter: ApiProxyTokenCounter = async () => {
    assert.fail("must not count an arbitrary target");
  };
  const fallback = await run([graph([sizeCondition()])], counter);
  assert.ok(fallback.ok && fallback.kind === "target");
  assert.equal(fallback.targetId, "A");
  assert.match(
    fallback.routeTrace.at(-1)?.detail ?? "",
    /estimated.*no unique downstream target/,
  );
  const strict = await run(
    [graph([sizeCondition({ onUnavailable: "error" })])],
    counter,
  );
  assert.ok(!strict.ok);
  assert.equal(strict.diagnostic.code, "arriero_proxy_token_count_unavailable");
});

test("auto follows converging branches, tail jumps, and call returns at the current call site", async () => {
  const pipelines = [
    graph(
      [
        {
          id: "call",
          type: "call",
          config: { pipelineId: "callee" },
          ports: { done: nodeRef("branch") },
        },
        {
          id: "branch",
          type: "condition",
          config: { predicate: { type: "source" } },
          ports: { true: targetA, false: { type: "pipeline", id: "alias" } },
        },
      ],
      "p",
      nodeRef("call"),
    ),
    graph(
      [
        limit(nodeRef("exit")),
        { id: "exit", type: "exit", config: { exitName: "done" } },
      ],
      "callee",
    ),
    ApiProxyPipelineRecordSchema.parse({
      id: "alias",
      name: "alias",
      enabled: true,
      entry: targetA,
      nodes: [],
    }),
  ];
  const calls: string[] = [];
  const result = await run(pipelines, async (_, targetId) => {
    calls.push(targetId);
    return { ok: true, tokens: 3, detail: "exact 3 tokens" };
  });
  assert.ok(result.ok && result.kind === "target");
  assert.equal(result.targetId, "A");
  assert.deepEqual(calls, ["A"]);
});

test("lookahead does not ignore unresolved or fusion paths", async () => {
  const counter: ApiProxyTokenCounter = async () => {
    assert.fail("unresolved graph cannot pick a target");
  };
  for (const next of [
    {
      id: "branch",
      type: "condition",
      config: { predicate: { type: "source" } },
      ports: { true: targetA, false: null },
    },
    {
      id: "branch",
      type: "fusion",
      config: {},
      ports: { panel: [targetA], synthesizer: targetA },
    },
  ]) {
    const result = await run(
      [graph([limit(nodeRef("branch"), { onUnavailable: "error" }), next])],
      counter,
    );
    assert.ok(!result.ok);
    assert.equal(
      result.diagnostic.code,
      "arriero_proxy_token_count_unavailable",
    );
  }
});

test("counting sees body edits in order and later guards receive the updated request", async () => {
  const bodies: unknown[] = [];
  const result = await run(
    [
      graph([
        limit(nodeRef("edit")),
        {
          id: "edit",
          type: "edit-request",
          config: {
            operations: [
              {
                kind: "set-field",
                path: "messages[0].content",
                value: "changed",
              },
            ],
          },
          ports: { next: nodeRef("after") },
        },
        limit(targetA, undefined, "after"),
      ]),
    ],
    async (request) => {
      bodies.push(request.body);
      return { ok: true, tokens: bodies.length, detail: "exact count" };
    },
  );
  assert.ok(result.ok);
  assert.deepEqual(
    bodies.map(
      (body) =>
        (body as { messages: { content: string }[] }).messages[0]?.content,
    ),
    ["hello", "changed"],
  );
});

test("unavailable upstream falls back visibly or returns a separate 503, while local mode never calls it", async () => {
  for (const onUnavailable of ["estimate", "error"] as const) {
    const result = await run(
      [graph([limit(targetA, { onUnavailable })])],
      async () => ({ ok: false, reason: "model is sleeping" }),
    );
    assert.equal(result.ok, onUnavailable === "estimate");
    assert.match(result.routeTrace.at(-1)?.detail ?? "", /model is sleeping/);
    if (!result.ok) assert.equal(result.diagnostic.status, 503);
  }
  const local = await run(
    [graph([limit(targetA, { mode: "local", onUnavailable: "error" })])],
    async () => {
      assert.fail("local mode must not call upstream");
    },
  );
  assert.ok(local.ok);
});

test("context limit rejects large agent history when exact counting is unavailable", async () => {
  const body = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "x".repeat(400_000) },
          { type: "tool_use", name: "read", input: { path: "/file" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text: "x".repeat(400_000) }],
          },
        ],
      },
    ],
  };
  const result = await run(
    [graph([{ ...limit(targetA), config: { thresholdTokens: 200_000 } }])],
    async () => ({ ok: false, reason: "model is sleeping" }),
    body,
    "anthropic",
  );
  assert.ok(!result.ok);
  assert.equal(result.diagnostic.code, "arriero_proxy_context_overflow");
  assert.match(
    result.routeTrace.at(-1)?.detail ?? "",
    /estimated.*model is sleeping.*rejected/,
  );
});

test("multimodal guards and conditions expose incomplete fallback estimates and preserve strict mode", async () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: [
              { type: "text", text: "screenshot" },
              {
                type: "image",
                source: { type: "base64", data: "A".repeat(900_000) },
              },
            ],
          },
        ],
      },
    ],
  };
  for (const mode of ["auto", "local"] as const) {
    for (const node of [
      limit(targetA, { mode }),
      sizeCondition({ mode, targetId: "A" }),
    ]) {
      const result = await run(
        [graph([node])],
        async () => {
          assert.equal(mode, "auto");
          return { ok: false, reason: "token counting returned HTTP 404" };
        },
        body,
        "anthropic",
      );
      assert.ok(result.ok && result.kind === "target");
      assert.equal(result.targetId, "A");
      assert.match(
        result.routeTrace.at(-1)?.detail ?? "",
        /estimated.*text only; images not estimated: 1/,
      );
    }
  }
  const strict = await run(
    [graph([limit(targetA, { onUnavailable: "error" })])],
    async () => ({ ok: false, reason: "token counting returned HTTP 404" }),
    body,
    "anthropic",
  );
  assert.ok(!strict.ok);
  assert.equal(strict.diagnostic.status, 503);
  assert.equal(strict.diagnostic.code, "arriero_proxy_token_count_unavailable");
});

test("context limit applies a 200000 threshold to the exact multimodal prompt count", async () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAA" },
          },
        ],
      },
    ],
  };
  const result = await run(
    [graph([{ ...limit(targetA), config: { thresholdTokens: 200_000 } }])],
    async (request) => {
      assert.deepEqual(request.body, body);
      return { ok: true, tokens: 223_712, detail: "exact 223712 tokens" };
    },
    body,
  );
  assert.ok(!result.ok);
  assert.equal(result.diagnostic.code, "arriero_proxy_context_overflow");
  assert.match(
    result.routeTrace.at(-1)?.detail ?? "",
    /exact 223712.*rejected/,
  );
});

test("counting target participates in reference validation and deletion protection", () => {
  const p = graph([
    limit(targetB, { ...defaultApiProxyTokenCountConfig, targetId: "A" }),
  ]);
  assert.deepEqual([...collectApiProxyPipelineRefs(p).targetIds].sort(), [
    "A",
    "B",
  ]);
  assert.match(
    validateApiProxyPipelineGraph(p, {
      getPipeline: () => null,
      hasTarget: (id) => id === "B",
    }) ?? "",
    /missing target "A"/,
  );
});

test("confirmed prompt bounds resolve overflow conditions and guards, including equality", async () => {
  for (const minimumTokens of [100, 101]) {
    const counter: ApiProxyTokenCounter = async (_, id) => {
      assert.equal(id, "A");
      return {
        ok: true,
        minimumTokens,
        detail: `at least ${minimumTokens} tokens for A`,
      };
    };
    const routed = await run(
      [graph([sizeCondition({ targetId: "A", onUnavailable: "error" })])],
      counter,
    );
    assert.ok(routed.ok && routed.kind === "target");
    assert.equal(routed.targetId, "B");
    assert.match(routed.routeTrace.at(-1)?.detail ?? "", /at least.*>= 100/);
    const guarded = await run(
      [graph([limit(targetA, { onUnavailable: "error" })])],
      counter,
    );
    assert.ok(!guarded.ok);
    assert.equal(guarded.diagnostic.code, "arriero_proxy_context_overflow");
    assert.match(guarded.routeTrace.at(-1)?.detail ?? "", /at least.*rejected/);
  }
});

test("a bound below the node threshold follows fallback policy instead of claiming the prompt fits", async () => {
  const counter: ApiProxyTokenCounter = async () => ({
    ok: true,
    minimumTokens: 99,
    detail: "at least 99 tokens for A",
  });
  for (const onUnavailable of ["estimate", "error"] as const) {
    for (const node of [
      limit(targetA, { onUnavailable }),
      sizeCondition({ targetId: "A", onUnavailable }),
    ]) {
      const result = await run([graph([node])], counter);
      assert.equal(result.ok, onUnavailable === "estimate");
      const detail = result.routeTrace.at(-1)?.detail ?? "";
      assert.match(detail, /at least 99.*bound does not resolve threshold 100/);
      if (result.ok) {
        assert.match(detail, /estimated/);
      } else {
        assert.equal(
          result.diagnostic.code,
          "arriero_proxy_token_count_unavailable",
        );
      }
    }
  }
});
