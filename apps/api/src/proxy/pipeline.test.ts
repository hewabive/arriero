import assert from "node:assert/strict";
import test from "node:test";

import {
  ApiProxyEditRequestOperationSchema,
  ApiProxyPipelineNodeSchema,
  ApiProxyPipelineRecordSchema,
  apiProxyOutputLimitEditOperations,
  apiProxyReasoningEditOperations,
  applyApiProxyRequestEdits,
  upgradeLegacyApiProxyPipeline,
  type ApiProxyEditRequestOperation,
  type ApiProxyPipelineNode,
  type ApiProxyPipelineRecord,
} from "@arriero/core";

import type { ApiProxyProtocolModelRequest } from "./protocol.js";
import {
  replaceRequestText,
  resolveApiProxyRouteChain,
  type ApiProxyPipelineRecordRequestInput,
} from "./pipeline.js";

function pipelineRecord(input: {
  id: string;
  name?: string;
  enabled?: boolean;
  entry: ApiProxyPipelineRecord["entry"];
  nodes?: ApiProxyPipelineNode[];
}): ApiProxyPipelineRecord {
  return {
    id: input.id,
    name: input.name ?? input.id,
    enabled: input.enabled ?? true,
    entry: input.entry,
    nodes: input.nodes ?? [],
  };
}

function getPipelineFrom(records: ApiProxyPipelineRecord[]) {
  return (id: string) => records.find((record) => record.id === id) ?? null;
}

function request(
  update: Partial<ApiProxyProtocolModelRequest> = {},
): ApiProxyProtocolModelRequest {
  return {
    operation: {
      protocol: "openai",
      endpoint: "chat.completions",
      routePath: "/v1/chat/completions",
      transport: "http-json",
    },
    body: {
      model: "public-model",
      messages: [{ role: "user", content: "hello bad text" }],
    },
    modelId: "public-model",
    model: {
      id: "model-a",
      modelId: "public-model",
      visible: true,
      enabled: true,
      ownedBy: "arriero",
      targetId: null,
      routeTo: { type: "pipeline", id: "pipeline-a" },
      description: null,
      blockedMessage: "",
    },
    stream: false,
    ...update,
  };
}

test("legacy pipeline record upgrades steps and routeTo to a node graph", () => {
  const record = ApiProxyPipelineRecordSchema.parse(
    upgradeLegacyApiProxyPipeline({
      id: "p1",
      name: "Legacy",
      enabled: true,
      nodeType: "replace-text",
      steps: [
        {
          id: "capture",
          name: "Capture request",
          enabled: true,
          type: "capture-request",
          config: { includeTransformedBody: true },
        },
        {
          id: "replace",
          name: "Replace text",
          enabled: true,
          type: "replace-text",
          config: {
            request: true,
            response: false,
            responseReasoning: false,
            responseToolArguments: false,
            rules: [{ enabled: true, find: "bad text", replace: "good text" }],
          },
        },
        {
          id: "off",
          name: "Disabled",
          enabled: false,
          type: "replace-text",
          config: { rules: [] },
        },
      ],
      routeTo: { type: "target", id: "target-a" },
    }),
  );

  assert.deepEqual(record.entry, { type: "node", id: "capture" });
  assert.equal(record.nodes.length, 2);
  const [captureNode, replaceNode] = record.nodes;
  assert.ok(captureNode && captureNode.type === "capture-request");
  assert.deepEqual(captureNode.ports, {
    next: { type: "node", id: "replace" },
  });
  assert.ok(replaceNode && replaceNode.type === "replace-text");
  assert.equal(replaceNode.config.request, true);
  assert.equal(replaceNode.config.response, false);
  assert.equal(replaceNode.config.responseReasoning, false);
  assert.equal(replaceNode.config.responseToolArguments, false);
  assert.deepEqual(replaceNode.ports, {
    next: { type: "target", id: "target-a" },
  });
  assert.ok(!("steps" in record));
  assert.ok(!("nodeType" in record));
});

test("capture-request saves the request as it arrives at the node", async () => {
  const saved: ApiProxyPipelineRecordRequestInput[] = [];
  const pipelines = [
    pipelineRecord({
      id: "pipeline-a",
      entry: { type: "node", id: "capture-before" },
      nodes: [
        {
          id: "capture-before",
          name: "",
          type: "capture-request",
          config: { request: true, response: false },
          ports: { next: { type: "node", id: "replace" } },
        },
        {
          id: "replace",
          name: "",
          type: "replace-text",
          config: {
            request: true,
            response: false,
            responseReasoning: false,
            responseToolArguments: false,
            rules: [{ enabled: true, find: "bad text", replace: "good text" }],
          },
          ports: { next: { type: "node", id: "capture-after" } },
        },
        {
          id: "capture-after",
          name: "",
          type: "capture-request",
          config: { request: true, response: false },
          ports: { next: { type: "target", id: "target-a" } },
        },
      ],
    }),
  ];

  const result = await resolveApiProxyRouteChain({
    request: request(),
    getPipeline: getPipelineFrom(pipelines),
    recordRequest: async (log) => {
      saved.push(log);
    },
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "target") {
    assert.equal(result.targetId, "target-a");
    assert.equal(result.textReplacementCount, 1);
    assert.deepEqual(result.request.body, {
      model: "public-model",
      messages: [{ role: "user", content: "hello good text" }],
    });
    assert.deepEqual(
      result.routeTrace.map((step) => step.kind),
      ["enter-pipeline", "capture-request", "replace-text", "capture-request"],
    );
  }
  assert.equal(saved.length, 2);
  assert.deepEqual(saved[0]?.requestBody, {
    model: "public-model",
    messages: [{ role: "user", content: "hello bad text" }],
  });
  assert.deepEqual(saved[1]?.requestBody, {
    model: "public-model",
    messages: [{ role: "user", content: "hello good text" }],
  });
});

test("capture node response flag yields a deferred response capture", async () => {
  const saved: ApiProxyPipelineRecordRequestInput[] = [];
  const pipelines = [
    pipelineRecord({
      id: "pipeline-a",
      entry: { type: "node", id: "capture" },
      nodes: [
        {
          id: "capture",
          name: "Audit",
          type: "capture-request",
          config: { request: false, response: true },
          ports: { next: { type: "target", id: "target-a" } },
        },
      ],
    }),
  ];

  const result = await resolveApiProxyRouteChain({
    request: request(),
    getPipeline: getPipelineFrom(pipelines),
    recordRequest: async (log) => {
      saved.push(log);
    },
  });

  assert.equal(saved.length, 0);
  assert.equal(result.ok, true);
  if (result.ok && result.kind === "target") {
    assert.deepEqual(result.responseEffects, [
      { type: "capture-response", nodeName: "Audit" },
    ]);
    assert.deepEqual(
      result.routeTrace.map((step) => step.detail),
      [null, "response at completion"],
    );
  }
});

test("response effects preserve their request-path encounter order", async () => {
  const pipelines = [
    pipelineRecord({
      id: "pipeline-a",
      entry: { type: "node", id: "capture-before" },
      nodes: [
        {
          id: "capture-before",
          name: "Before",
          type: "capture-request",
          config: { request: false, response: true },
          ports: { next: { type: "node", id: "cache" } },
        },
        {
          id: "cache",
          name: "Cache",
          type: "cache",
          config: { ttlSeconds: 600, namespace: "ordered-effects" },
          ports: { next: { type: "node", id: "capture-after" } },
        },
        {
          id: "capture-after",
          name: "After",
          type: "capture-request",
          config: { request: false, response: true },
          ports: { next: { type: "target", id: "target-a" } },
        },
      ],
    }),
  ];

  const result = await resolveApiProxyRouteChain({
    request: request(),
    getPipeline: getPipelineFrom(pipelines),
    lookupCache: () => null,
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "target") {
    assert.deepEqual(
      result.responseEffects.map((effect) => effect.type),
      ["capture-response", "cache-store", "capture-response"],
    );
    assert.equal(result.responseEffects[0]?.type, "capture-response");
    assert.equal(result.responseEffects[2]?.type, "capture-response");
    if (
      result.responseEffects[0]?.type === "capture-response" &&
      result.responseEffects[2]?.type === "capture-response"
    ) {
      assert.equal(result.responseEffects[0].nodeName, "Before");
      assert.equal(result.responseEffects[2].nodeName, "After");
    }
  }
});

test("replace-text does not touch the routing model field", async () => {
  const pipelines = [
    pipelineRecord({
      id: "pipeline-a",
      entry: { type: "node", id: "replace" },
      nodes: [
        {
          id: "replace",
          name: "",
          type: "replace-text",
          config: {
            rules: [{ enabled: true, find: "bad text", replace: "good text" }],
            request: true,
            response: false,
            responseReasoning: false,
            responseToolArguments: false,
          },
          ports: { next: { type: "target", id: "target-a" } },
        },
      ],
    }),
  ];

  const result = await resolveApiProxyRouteChain({
    request: request({ body: { model: "bad text", prompt: "bad text" } }),
    getPipeline: getPipelineFrom(pipelines),
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "target") {
    assert.deepEqual(result.request.body, {
      model: "bad text",
      prompt: "good text",
    });
  }
});

test("replace-text can defer response replacement without changing the request", async () => {
  const pipelines = [
    pipelineRecord({
      id: "pipeline-a",
      entry: { type: "node", id: "replace" },
      nodes: [
        {
          id: "replace",
          name: "Response scrubber",
          type: "replace-text",
          config: {
            rules: [{ enabled: true, find: "secret", replace: "[hidden]" }],
            request: false,
            response: true,
            responseReasoning: true,
            responseToolArguments: false,
          },
          ports: { next: { type: "target", id: "target-a" } },
        },
      ],
    }),
  ];
  const original = request({
    body: { model: "public-model", prompt: "secret" },
  });

  const result = await resolveApiProxyRouteChain({
    request: original,
    getPipeline: getPipelineFrom(pipelines),
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "target") {
    assert.equal(result.request.body, original.body);
    assert.deepEqual(result.responseEffects, [
      {
        type: "replace-response-text",
        rules: [{ enabled: true, find: "secret", replace: "[hidden]" }],
        includeReasoning: true,
        includeToolArguments: false,
      },
    ]);
    assert.equal(
      result.routeTrace[1]?.detail,
      "request: disabled · response at completion",
    );
  }
});

test("replace-text matches literally, including real line breaks", () => {
  const rule = (find: string, replace: string) => [
    { enabled: true, find, replace },
  ];

  const multiline = replaceRequestText(
    { prompt: "say:\ntest\ntest\ntest\nbye" },
    rule("test\ntest\ntest", "hello"),
  );
  assert.equal(multiline.count, 1);
  assert.deepEqual(multiline.value, { prompt: "say:\nhello\nbye" });

  const literalBackslash = replaceRequestText(
    { prompt: "raw \\n marker" },
    rule("\\n", "newline"),
  );
  assert.equal(literalBackslash.count, 1);
  assert.deepEqual(literalBackslash.value, { prompt: "raw newline marker" });

  const noEscapeDecoding = replaceRequestText(
    { prompt: "one\ntwo" },
    rule("\\n", "space"),
  );
  assert.equal(noEscapeDecoding.count, 0);
  assert.deepEqual(noEscapeDecoding.value, { prompt: "one\ntwo" });
});

function openaiTool(name: string): Record<string, unknown> {
  return { type: "function", function: { name, parameters: {} } };
}

test("edit-request remove-tool drops matching tools and dangling tool_choice", () => {
  const body = {
    model: "public-model",
    tools: [openaiTool("Bash"), openaiTool("Read"), openaiTool("Write")],
    tool_choice: { type: "function", function: { name: "Bash" } },
  };

  const result = applyApiProxyRequestEdits(body, [
    { kind: "remove-tool", enabled: true, toolName: "Bash" },
  ]);

  assert.equal(result.changed, true);
  assert.deepEqual(result.body, {
    model: "public-model",
    tools: [openaiTool("Read"), openaiTool("Write")],
  });
  assert.equal(result.outcomes[0]?.matched, 1);
  assert.match(result.outcomes[0]?.detail ?? "", /removed 1 tool\(s\): Bash/);
  assert.match(result.outcomes[0]?.detail ?? "", /dropped tool_choice "Bash"/);
  assert.deepEqual(body.tools.length, 3);
});

test("edit-request remove-tool wildcard matches anthropic-shaped tools and drops empty tools key", () => {
  const body = {
    model: "public-model",
    tools: [
      { name: "mcp__browser_search", input_schema: {} },
      { name: "mcp__browser_fetch", input_schema: {} },
    ],
  };

  const result = applyApiProxyRequestEdits(body, [
    { kind: "remove-tool", enabled: true, toolName: "mcp__*" },
  ]);

  assert.equal(result.changed, true);
  assert.deepEqual(result.body, { model: "public-model" });
  assert.equal(result.outcomes[0]?.matched, 2);
  assert.deepEqual(result.outcomes[0]?.toolNames, [
    "mcp__browser_search",
    "mcp__browser_fetch",
  ]);
});

test("edit-request replace-tool and add-tool rewrite the tools array", () => {
  const custom = { name: "custom_tool", input_schema: { type: "object" } };
  const body = { model: "public-model", tools: [openaiTool("Bash")] };

  const result = applyApiProxyRequestEdits(body, [
    { kind: "replace-tool", enabled: true, toolName: "Bash", value: custom },
    { kind: "add-tool", enabled: true, value: { name: "extra_tool" } },
  ]);

  assert.equal(result.changed, true);
  assert.deepEqual(result.body, {
    model: "public-model",
    tools: [custom, { name: "extra_tool" }],
  });
  assert.match(
    result.outcomes[0]?.detail ?? "",
    /replaced 1 tool\(s\) Bash with "custom_tool"/,
  );
  assert.match(result.outcomes[1]?.detail ?? "", /added tool "extra_tool"/);
});

test("edit-request add-tool creates the tools array when missing", () => {
  const result = applyApiProxyRequestEdits({ model: "public-model" }, [
    { kind: "add-tool", enabled: true, value: { name: "only_tool" } },
  ]);

  assert.equal(result.changed, true);
  assert.deepEqual(result.body, {
    model: "public-model",
    tools: [{ name: "only_tool" }],
  });
});

test("edit-request reports no-match and skips disabled operations without changing the body", () => {
  const body = { model: "public-model", tools: [openaiTool("Bash")] };
  const operations: ApiProxyEditRequestOperation[] = [
    { kind: "remove-tool", enabled: true, toolName: "missing_tool" },
    { kind: "remove-tool", enabled: false, toolName: "Bash" },
  ];

  const result = applyApiProxyRequestEdits(body, operations);

  assert.equal(result.changed, false);
  assert.equal(result.body, body);
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0]?.matched, 0);
  assert.match(
    result.outcomes[0]?.detail ?? "",
    /no tool matches "missing_tool"/,
  );
});

test("edit-request set-field overrides a top-level field without mutating the original body", () => {
  const body = { model: "public-model", max_tokens: 16384 };

  const result = applyApiProxyRequestEdits(body, [
    { kind: "set-field", enabled: true, path: "max_tokens", value: 512 },
  ]);

  assert.equal(result.changed, true);
  assert.deepEqual(result.body, { model: "public-model", max_tokens: 512 });
  assert.equal(result.outcomes[0]?.matched, 1);
  assert.match(
    result.outcomes[0]?.detail ?? "",
    /set max_tokens = 512 \(was 16384\)/,
  );
  assert.equal(body.max_tokens, 16384);
});

test("edit-request set-field creates missing intermediate objects", () => {
  const result = applyApiProxyRequestEdits({ model: "public-model" }, [
    {
      kind: "set-field",
      enabled: true,
      path: "stream_options.include_usage",
      value: true,
    },
  ]);

  assert.equal(result.changed, true);
  assert.deepEqual(result.body, {
    model: "public-model",
    stream_options: { include_usage: true },
  });
  assert.match(
    result.outcomes[0]?.detail ?? "",
    /set stream_options\.include_usage = true/,
  );
});

test("edit-request set-field with array index copies the path and leaves shared structure intact", () => {
  const original = {
    model: "public-model",
    messages: [
      { role: "system", content: "keep" },
      { role: "user", content: "hello" },
    ],
  };

  const result = applyApiProxyRequestEdits(original, [
    {
      kind: "set-field",
      enabled: true,
      path: "messages[1].content",
      value: "rewritten",
    },
  ]);

  assert.equal(result.changed, true);
  const edited = result.body as typeof original;
  assert.equal(edited.messages[1]?.content, "rewritten");
  assert.equal(original.messages[1]?.content, "hello");
  assert.equal(edited.messages[0], original.messages[0]);
});

test("edit-request set-field appends at array length and rejects out-of-range indices", () => {
  const body = { stop: ["a"] };

  const appended = applyApiProxyRequestEdits(body, [
    { kind: "set-field", enabled: true, path: "stop[1]", value: "b" },
  ]);
  assert.deepEqual(appended.body, { stop: ["a", "b"] });

  const outOfRange = applyApiProxyRequestEdits(body, [
    { kind: "set-field", enabled: true, path: "stop[5]", value: "z" },
  ]);
  assert.equal(outOfRange.changed, false);
  assert.equal(outOfRange.outcomes[0]?.matched, 0);
  assert.match(outOfRange.outcomes[0]?.detail ?? "", /out of range/);
});

test("edit-request set-field reports a type mismatch instead of descending into scalars", () => {
  const result = applyApiProxyRequestEdits(
    { model: "public-model", max_tokens: 100 },
    [{ kind: "set-field", enabled: true, path: "max_tokens.limit", value: 1 }],
  );

  assert.equal(result.changed, false);
  assert.equal(result.outcomes[0]?.matched, 0);
  assert.match(
    result.outcomes[0]?.detail ?? "",
    /max_tokens is not an object or array/,
  );
});

test("edit-request remove-field deletes fields and reports absent paths", () => {
  const body = {
    model: "public-model",
    temperature: 0.7,
    options: { seed: 42, keep: true },
  };

  const result = applyApiProxyRequestEdits(body, [
    { kind: "remove-field", enabled: true, path: "temperature" },
    { kind: "remove-field", enabled: true, path: "options.seed" },
    { kind: "remove-field", enabled: true, path: "options.missing" },
  ]);

  assert.equal(result.changed, true);
  assert.deepEqual(result.body, {
    model: "public-model",
    options: { keep: true },
  });
  assert.match(
    result.outcomes[0]?.detail ?? "",
    /removed temperature \(was 0\.7\)/,
  );
  assert.equal(result.outcomes[2]?.matched, 0);
  assert.match(
    result.outcomes[2]?.detail ?? "",
    /options\.missing is not present/,
  );
  assert.deepEqual(body.options, { seed: 42, keep: true });
});

test("edit-request remove-field splices array elements", () => {
  const result = applyApiProxyRequestEdits(
    { messages: [{ role: "system" }, { role: "user" }] },
    [{ kind: "remove-field", enabled: true, path: "messages[0]" }],
  );

  assert.equal(result.changed, true);
  assert.deepEqual(result.body, { messages: [{ role: "user" }] });
});

test("edit-request field operation schema accepts valid paths and rejects malformed ones", () => {
  assert.equal(
    ApiProxyEditRequestOperationSchema.safeParse({
      kind: "set-field",
      path: "messages[0].content",
      value: { nested: ["ok", 1, null] },
    }).success,
    true,
  );
  for (const path of ["", "a..b", "a.[0]", "a[x]", "a]b", "a["]) {
    assert.equal(
      ApiProxyEditRequestOperationSchema.safeParse({
        kind: "remove-field",
        path,
      }).success,
      false,
      `path ${JSON.stringify(path)} should be rejected`,
    );
  }
});

test("edit-request node edits the body mid-route and traces operation outcomes", async () => {
  const pipelines = [
    pipelineRecord({
      id: "pipeline-a",
      entry: { type: "node", id: "edit" },
      nodes: [
        {
          id: "edit",
          name: "",
          type: "edit-request",
          config: {
            operations: [
              { kind: "remove-tool", enabled: true, toolName: "Bash" },
              { kind: "remove-tool", enabled: true, toolName: "ghost" },
            ],
          },
          ports: { next: { type: "target", id: "target-a" } },
        },
      ],
    }),
  ];

  const result = await resolveApiProxyRouteChain({
    request: request({
      body: {
        model: "public-model",
        messages: [{ role: "user", content: "hi" }],
        tools: [openaiTool("Bash"), openaiTool("Read")],
      },
    }),
    getPipeline: getPipelineFrom(pipelines),
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "target") {
    assert.equal(result.targetId, "target-a");
    assert.deepEqual(result.request.body, {
      model: "public-model",
      messages: [{ role: "user", content: "hi" }],
      tools: [openaiTool("Read")],
    });
    assert.equal(result.routeTrace[1]?.kind, "edit-request");
    assert.equal(
      result.routeTrace[1]?.detail,
      'removed 1 tool(s): Bash; no tool matches "ghost"',
    );
  }
});

function stripAttributionPipeline(): ApiProxyPipelineRecord {
  return pipelineRecord({
    id: "pipeline-a",
    entry: { type: "node", id: "strip" },
    nodes: [
      {
        id: "strip",
        name: "",
        type: "strip-attribution",
        config: {},
        ports: { next: { type: "target", id: "target-a" } },
      },
    ],
  });
}

test("strip-attribution removes the claude code attribution block mid-route", async () => {
  const result = await resolveApiProxyRouteChain({
    request: request({
      operation: {
        protocol: "anthropic",
        endpoint: "messages",
        routePath: "/v1/messages",
        transport: "http-json",
      },
      body: {
        model: "public-model",
        system: [
          {
            type: "text",
            text: "x-anthropic-billing-header: cc_version=2.1.37; cc_entrypoint=cli; cch=14f72;",
          },
          { type: "text", text: "You are X." },
        ],
        messages: [{ role: "user", content: "hi" }],
      },
    }),
    getPipeline: getPipelineFrom([stripAttributionPipeline()]),
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "target") {
    assert.equal(result.targetId, "target-a");
    assert.deepEqual(result.request.body, {
      model: "public-model",
      system: [{ type: "text", text: "You are X." }],
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(result.routeTrace[1]?.kind, "strip-attribution");
    assert.equal(result.routeTrace[1]?.detail, "attribution stripped");
  }
});

test("strip-attribution leaves a clean body untouched and reports no-op", async () => {
  const clean = {
    model: "public-model",
    messages: [{ role: "user", content: "hi" }],
  };
  const result = await resolveApiProxyRouteChain({
    request: request({ body: clean }),
    getPipeline: getPipelineFrom([stripAttributionPipeline()]),
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "target") {
    assert.deepEqual(result.request.body, clean);
    assert.equal(result.routeTrace[1]?.detail, "no attribution found");
  }
});

function cachePipeline(): ApiProxyPipelineRecord {
  return pipelineRecord({
    id: "pipeline-a",
    entry: { type: "node", id: "cache" },
    nodes: [
      {
        id: "cache",
        name: "",
        type: "cache",
        config: { ttlSeconds: 600, namespace: "" },
        ports: { next: { type: "target", id: "target-a" } },
      },
    ],
  });
}

test("cache node short-circuits to a response on a hit", async () => {
  const result = await resolveApiProxyRouteChain({
    request: request({ body: { model: "public-model", input: "x" } }),
    getPipeline: getPipelineFrom([cachePipeline()]),
    lookupCache: () => ({
      status: 200,
      contentType: "application/json",
      isSse: false,
      body: '{"object":"list"}',
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.kind, "response");
  if (result.ok && result.kind === "response") {
    assert.equal(result.response.body, '{"object":"list"}');
    assert.ok(result.cacheKey.length > 0);
    assert.equal(result.routeTrace.at(-1)?.detail, "cache hit");
  }
});

test("cache node misses to the target and records a cache write", async () => {
  let seenKey: string | null = null;
  const result = await resolveApiProxyRouteChain({
    request: request({ body: { model: "public-model", input: "x" } }),
    getPipeline: getPipelineFrom([cachePipeline()]),
    lookupCache: (key) => {
      seenKey = key;
      return null;
    },
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "target") {
    const cacheWrites = result.responseEffects.filter(
      (effect) => effect.type === "cache-store",
    );
    assert.equal(result.targetId, "target-a");
    assert.equal(cacheWrites.length, 1);
    assert.equal(cacheWrites[0]?.key, seenKey);
    assert.equal(cacheWrites[0]?.ttlSeconds, 600);
    assert.equal(result.routeTrace.at(-1)?.detail, "cache miss");
  }
});

test("cache node coalesces onto an in-flight owner instead of forwarding", async () => {
  const owners: string[] = [];
  const result = await resolveApiProxyRouteChain({
    request: request({ body: { model: "public-model", input: "x" } }),
    getPipeline: getPipelineFrom([cachePipeline()]),
    lookupCache: () => null,
    findInFlight: () =>
      Promise.resolve({
        status: 200,
        contentType: "application/json",
        isSse: false,
        body: '{"coalesced":true}',
      }),
    registerOwner: (key) => owners.push(key),
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "response") {
    assert.equal(result.source, "coalesced");
    assert.equal(result.response.body, '{"coalesced":true}');
    assert.equal(result.routeTrace.at(-1)?.detail, "cache coalesced");
  }
  assert.deepEqual(owners, []);
});

test("cache node registers as owner when no request is in flight", async () => {
  const owners: string[] = [];
  const result = await resolveApiProxyRouteChain({
    request: request({ body: { model: "public-model", input: "x" } }),
    getPipeline: getPipelineFrom([cachePipeline()]),
    lookupCache: () => null,
    findInFlight: () => null,
    registerOwner: (key) => owners.push(key),
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "target") {
    const cacheWrites = result.responseEffects.filter(
      (effect) => effect.type === "cache-store",
    );
    assert.equal(cacheWrites.length, 1);
    assert.equal(owners.length, 1);
    assert.equal(owners[0], cacheWrites[0]?.key);
  }
});

test("cache node falls through to a plain miss when the owner failed", async () => {
  const owners: string[] = [];
  const result = await resolveApiProxyRouteChain({
    request: request({ body: { model: "public-model", input: "x" } }),
    getPipeline: getPipelineFrom([cachePipeline()]),
    lookupCache: () => null,
    findInFlight: () => Promise.resolve(null),
    registerOwner: (key) => owners.push(key),
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "target") {
    assert.equal(
      result.responseEffects.filter((effect) => effect.type === "cache-store")
        .length,
      1,
    );
    assert.equal(
      result.routeTrace.at(-1)?.detail,
      "cache miss (coalesce fallthrough)",
    );
  }
  assert.deepEqual(owners, []);
});

test("non-stream request treats a stored SSE entry as a miss", async () => {
  const result = await resolveApiProxyRouteChain({
    request: request({ body: { model: "public-model", input: "x" } }),
    getPipeline: getPipelineFrom([cachePipeline()]),
    lookupCache: () => ({
      status: 200,
      contentType: "text/event-stream",
      isSse: true,
      body: "data: x\n\n",
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.kind, "target");
});

test("streaming request replays a stored SSE entry", async () => {
  const result = await resolveApiProxyRouteChain({
    request: request({
      body: { model: "public-model", messages: [], stream: true },
      stream: true,
    }),
    getPipeline: getPipelineFrom([cachePipeline()]),
    lookupCache: () => ({
      status: 200,
      contentType: "text/event-stream",
      isSse: true,
      body: "data: hi\n\n",
    }),
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "response") {
    assert.equal(result.source, "store");
    assert.equal(result.response.body, "data: hi\n\n");
    assert.equal(result.response.contentType, "text/event-stream");
  }
});

test("streaming request fans out onto a live broadcast", async () => {
  const stream = new ReadableStream<Uint8Array>();
  const result = await resolveApiProxyRouteChain({
    request: request({
      body: { model: "public-model", messages: [], stream: true },
      stream: true,
    }),
    getPipeline: getPipelineFrom([cachePipeline()]),
    lookupCache: () => null,
    findBroadcast: () => ({ contentType: "text/event-stream", body: stream }),
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "response") {
    assert.equal(result.source, "coalesced");
    assert.equal(result.response.body, stream);
    assert.equal(result.routeTrace.at(-1)?.detail, "stream fan-out");
  }
});

test("streaming request becomes the broadcast owner on a miss", async () => {
  const owners: string[] = [];
  const result = await resolveApiProxyRouteChain({
    request: request({
      body: { model: "public-model", messages: [], stream: true },
      stream: true,
    }),
    getPipeline: getPipelineFrom([cachePipeline()]),
    lookupCache: () => null,
    findBroadcast: () => null,
    registerBroadcast: (key) => owners.push(key),
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "target") {
    const cacheWrites = result.responseEffects.filter(
      (effect) => effect.type === "cache-store",
    );
    assert.equal(cacheWrites.length, 1);
    assert.equal(owners.length, 1);
    assert.equal(owners[0], cacheWrites[0]?.key);
    assert.equal(result.routeTrace.at(-1)?.detail, "stream cache miss (owner)");
  }
});

function doubleCachePipeline(): ApiProxyPipelineRecord {
  return pipelineRecord({
    id: "pipeline-a",
    entry: { type: "node", id: "cache-1" },
    nodes: [
      {
        id: "cache-1",
        name: "",
        type: "cache",
        config: { ttlSeconds: 600, namespace: "" },
        ports: { next: { type: "node", id: "cache-2" } },
      },
      {
        id: "cache-2",
        name: "",
        type: "cache",
        config: { ttlSeconds: 600, namespace: "" },
        ports: { next: { type: "target", id: "target-a" } },
      },
    ],
  });
}

test("a second cache node with the same key passes through instead of self-coalescing", async () => {
  const owners: string[] = [];
  const result = await resolveApiProxyRouteChain({
    request: request({ body: { model: "public-model", input: "x" } }),
    getPipeline: getPipelineFrom([doubleCachePipeline()]),
    lookupCache: () => null,
    findInFlight: (key) =>
      owners.includes(key) ? new Promise<null>(() => {}) : null,
    registerOwner: (key) => owners.push(key),
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.kind, "target");
  if (result.ok && result.kind === "target") {
    const cacheWrites = result.responseEffects.filter(
      (effect) => effect.type === "cache-store",
    );
    assert.equal(cacheWrites.length, 1);
    assert.equal(owners.length, 1);
    assert.equal(
      result.routeTrace.at(-1)?.detail,
      "duplicate cache key (pass-through)",
    );
  }
});

test("a route failure after a cache miss still reports the registered store effect", async () => {
  const owners: string[] = [];
  const pipeline = pipelineRecord({
    id: "pipeline-a",
    entry: { type: "node", id: "cache" },
    nodes: [
      {
        id: "cache",
        name: "",
        type: "cache",
        config: { ttlSeconds: 600, namespace: "" },
        ports: { next: null },
      },
    ],
  });
  const result = await resolveApiProxyRouteChain({
    request: request({ body: { model: "public-model", input: "x" } }),
    getPipeline: getPipelineFrom([pipeline]),
    lookupCache: () => null,
    findInFlight: () => null,
    registerOwner: (key) => owners.push(key),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(owners.length, 1);
    const cacheWrites = result.responseEffects.filter(
      (effect) => effect.type === "cache-store",
    );
    assert.equal(cacheWrites.length, 1);
    assert.equal(cacheWrites[0]?.key, owners[0]);
  }
});

function conditionPipeline(
  predicate: Extract<
    ApiProxyPipelineNode,
    { type: "condition" }
  >["config"]["predicate"],
): ApiProxyPipelineRecord {
  return pipelineRecord({
    id: "pipeline-a",
    entry: { type: "node", id: "cond" },
    nodes: [
      {
        id: "cond",
        name: "",
        type: "condition",
        config: { predicate },
        ports: {
          true: { type: "target", id: "target-true" },
          false: { type: "target", id: "target-false" },
        },
      },
    ],
  });
}

test("condition text-match regex routes by message content", async () => {
  const pipelines = [
    conditionPipeline({
      type: "text-match",
      scope: "last-user-message",
      pattern: "bad\\s+text",
      regex: true,
      caseSensitive: false,
    }),
  ];

  const matched = await resolveApiProxyRouteChain({
    request: request(),
    getPipeline: getPipelineFrom(pipelines),
  });
  assert.equal(matched.ok, true);
  if (matched.ok && matched.kind === "target") {
    assert.equal(matched.targetId, "target-true");
    assert.equal(matched.routeTrace[1]?.port, "true");
  }

  const missed = await resolveApiProxyRouteChain({
    request: request({
      body: {
        model: "public-model",
        messages: [{ role: "user", content: "all fine here" }],
      },
    }),
    getPipeline: getPipelineFrom(pipelines),
  });
  assert.equal(missed.ok, true);
  if (missed.ok && missed.kind === "target") {
    assert.equal(missed.targetId, "target-false");
  }
});

test("condition token-estimate routes long requests separately", async () => {
  const pipelines = [
    conditionPipeline({ type: "token-estimate", minTokens: 1000 }),
  ];

  const long = await resolveApiProxyRouteChain({
    request: request({
      body: {
        model: "public-model",
        messages: [{ role: "user", content: "word ".repeat(2000) }],
      },
    }),
    getPipeline: getPipelineFrom(pipelines),
  });
  assert.equal(long.ok, true);
  if (long.ok && long.kind === "target") {
    assert.equal(long.targetId, "target-true");
    assert.match(long.routeTrace[1]?.detail ?? "", /~\d+ tokens >= 1000/);
  }

  const short = await resolveApiProxyRouteChain({
    request: request(),
    getPipeline: getPipelineFrom(pipelines),
  });
  assert.equal(short.ok, true);
  if (short.ok && short.kind === "target") {
    assert.equal(short.targetId, "target-false");
  }
});

test("condition source matches the resolved request source", async () => {
  const pipelines = [
    conditionPipeline({ type: "source", sourceId: "src-claude" }),
  ];

  const fromSource = await resolveApiProxyRouteChain({
    request: request(),
    getPipeline: getPipelineFrom(pipelines),
    sourceId: "src-claude",
  });
  assert.equal(fromSource.ok, true);
  if (fromSource.ok && fromSource.kind === "target") {
    assert.equal(fromSource.targetId, "target-true");
  }

  const anonymous = await resolveApiProxyRouteChain({
    request: request(),
    getPipeline: getPipelineFrom(pipelines),
  });
  assert.equal(anonymous.ok, true);
  if (anonymous.ok && anonymous.kind === "target") {
    assert.equal(anonymous.targetId, "target-false");
  }
});

function callerPipeline(
  ports: Record<string, { type: "node" | "target" | "pipeline"; id: string }>,
): ApiProxyPipelineRecord {
  return pipelineRecord({
    id: "caller",
    entry: { type: "node", id: "call-fn" },
    nodes: [
      {
        id: "call-fn",
        name: "",
        type: "call",
        config: { pipelineId: "fn" },
        ports,
      },
    ],
  });
}

function functionPipeline(): ApiProxyPipelineRecord {
  return pipelineRecord({
    id: "fn",
    entry: { type: "node", id: "cond" },
    nodes: [
      {
        id: "cond",
        name: "",
        type: "condition",
        config: {
          predicate: {
            type: "text-match",
            scope: "any-message",
            pattern: "bad text",
            regex: false,
            caseSensitive: false,
          },
        },
        ports: {
          true: { type: "node", id: "exit-matched" },
          false: { type: "node", id: "exit-clean" },
        },
      },
      {
        id: "exit-matched",
        name: "",
        type: "exit",
        config: { exitName: "matched" },
      },
      {
        id: "exit-clean",
        name: "",
        type: "exit",
        config: { exitName: "clean" },
      },
    ],
  });
}

test("call returns through the wired exit of the callee", async () => {
  const pipelines = [
    callerPipeline({
      matched: { type: "target", id: "target-matched" },
      clean: { type: "target", id: "target-clean" },
    }),
    functionPipeline(),
  ];

  const result = await resolveApiProxyRouteChain({
    request: request({
      model: {
        ...request().model,
        routeTo: { type: "pipeline", id: "caller" },
      },
    }),
    getPipeline: getPipelineFrom(pipelines),
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "target") {
    assert.equal(result.targetId, "target-matched");
    assert.deepEqual(
      result.routeTrace.map((step) => step.kind),
      ["enter-pipeline", "call", "enter-pipeline", "condition", "exit"],
    );
  }
});

test("target inside a called pipeline terminates the route", async () => {
  const fn = pipelineRecord({
    id: "fn",
    entry: { type: "node", id: "cond" },
    nodes: [
      {
        id: "cond",
        name: "",
        type: "condition",
        config: {
          predicate: {
            type: "text-match",
            scope: "any-message",
            pattern: "bad text",
            regex: false,
            caseSensitive: false,
          },
        },
        ports: {
          true: { type: "target", id: "target-inner" },
          false: { type: "node", id: "exit-clean" },
        },
      },
      {
        id: "exit-clean",
        name: "",
        type: "exit",
        config: { exitName: "clean" },
      },
    ],
  });
  const pipelines = [
    callerPipeline({ clean: { type: "target", id: "target-clean" } }),
    fn,
  ];

  const result = await resolveApiProxyRouteChain({
    request: request({
      model: {
        ...request().model,
        routeTo: { type: "pipeline", id: "caller" },
      },
    }),
    getPipeline: getPipelineFrom(pipelines),
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "target") {
    assert.equal(result.targetId, "target-inner");
  }
});

test("exit of a jumped-to pipeline returns to the original caller frame", async () => {
  const fn = pipelineRecord({
    id: "fn",
    entry: { type: "pipeline", id: "tail" },
  });
  const tail = pipelineRecord({
    id: "tail",
    entry: { type: "node", id: "exit-done" },
    nodes: [
      {
        id: "exit-done",
        name: "",
        type: "exit",
        config: { exitName: "done" },
      },
    ],
  });
  const pipelines = [
    callerPipeline({ done: { type: "target", id: "target-x" } }),
    fn,
    tail,
  ];

  const result = await resolveApiProxyRouteChain({
    request: request({
      model: {
        ...request().model,
        routeTo: { type: "pipeline", id: "caller" },
      },
    }),
    getPipeline: getPipelineFrom(pipelines),
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "target") {
    assert.equal(result.targetId, "target-x");
  }
});

test("recursive call fails with a cycle diagnostic", async () => {
  const a = pipelineRecord({
    id: "a",
    entry: { type: "node", id: "call-b" },
    nodes: [
      {
        id: "call-b",
        name: "",
        type: "call",
        config: { pipelineId: "b" },
        ports: {},
      },
    ],
  });
  const b = pipelineRecord({
    id: "b",
    entry: { type: "node", id: "call-a" },
    nodes: [
      {
        id: "call-a",
        name: "",
        type: "call",
        config: { pipelineId: "a" },
        ports: {},
      },
    ],
  });

  const result = await resolveApiProxyRouteChain({
    request: request({
      model: { ...request().model, routeTo: { type: "pipeline", id: "a" } },
    }),
    getPipeline: getPipelineFrom([a, b]),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostic.code, "arriero_proxy_pipeline_cycle");
  }
});

test("unwired exit fails with route_unbound naming the call node", async () => {
  const pipelines = [callerPipeline({}), functionPipeline()];

  const result = await resolveApiProxyRouteChain({
    request: request({
      model: {
        ...request().model,
        routeTo: { type: "pipeline", id: "caller" },
      },
    }),
    getPipeline: getPipelineFrom(pipelines),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostic.code, "arriero_proxy_route_unbound");
    assert.match(result.diagnostic.message, /no wiring for exit "matched"/);
  }
});

test("dangling node port fails with route_unbound", async () => {
  const pipelines = [
    pipelineRecord({
      id: "pipeline-a",
      entry: { type: "node", id: "replace" },
      nodes: [
        {
          id: "replace",
          name: "",
          type: "replace-text",
          config: {
            rules: [],
            request: true,
            response: false,
            responseReasoning: false,
            responseToolArguments: false,
          },
          ports: { next: null },
        },
      ],
    }),
  ];

  const result = await resolveApiProxyRouteChain({
    request: request(),
    getPipeline: getPipelineFrom(pipelines),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostic.code, "arriero_proxy_route_unbound");
  }
});

test("model without route fails with route_unbound", async () => {
  const result = await resolveApiProxyRouteChain({
    request: request({ model: { ...request().model, routeTo: null } }),
    getPipeline: () => null,
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.diagnostic.code, "arriero_proxy_route_unbound");
  }
});

test("apiProxyReasoningEditOperations maps effort to protocol-specific fields", () => {
  assert.deepEqual(
    apiProxyReasoningEditOperations(
      { effort: "high", customBudgetTokens: 2048 },
      "openai",
    ),
    [
      {
        kind: "set-field",
        enabled: true,
        path: "chat_template_kwargs.enable_thinking",
        value: true,
      },
      {
        kind: "set-field",
        enabled: true,
        path: "thinking_budget_tokens",
        value: 8192,
      },
    ],
  );
  assert.deepEqual(
    apiProxyReasoningEditOperations(
      { effort: "off", customBudgetTokens: 2048 },
      "openai",
    ),
    [
      {
        kind: "set-field",
        enabled: true,
        path: "chat_template_kwargs.enable_thinking",
        value: false,
      },
    ],
  );
  assert.deepEqual(
    apiProxyReasoningEditOperations(
      { effort: "max", customBudgetTokens: 2048 },
      "openai",
    ),
    [
      {
        kind: "set-field",
        enabled: true,
        path: "chat_template_kwargs.enable_thinking",
        value: true,
      },
    ],
  );
  assert.deepEqual(
    apiProxyReasoningEditOperations(
      { effort: "low", customBudgetTokens: 2048 },
      "anthropic",
    ),
    [
      {
        kind: "set-field",
        enabled: true,
        path: "thinking",
        value: { type: "enabled", budget_tokens: 512 },
      },
    ],
  );
  assert.deepEqual(
    apiProxyReasoningEditOperations(
      { effort: "off", customBudgetTokens: 2048 },
      "anthropic",
    ),
    [
      {
        kind: "set-field",
        enabled: true,
        path: "thinking",
        value: { type: "disabled" },
      },
    ],
  );
  assert.deepEqual(
    apiProxyReasoningEditOperations(
      { effort: "custom", customBudgetTokens: 1234 },
      "openai",
    ),
    [
      {
        kind: "set-field",
        enabled: true,
        path: "chat_template_kwargs.enable_thinking",
        value: true,
      },
      {
        kind: "set-field",
        enabled: true,
        path: "thinking_budget_tokens",
        value: 1234,
      },
    ],
  );
});

function reasoningPipeline(): ApiProxyPipelineRecord[] {
  return [
    pipelineRecord({
      id: "pipeline-a",
      entry: { type: "node", id: "reason" },
      nodes: [
        {
          id: "reason",
          name: "",
          type: "reasoning",
          config: { effort: "high", customBudgetTokens: 2048 },
          ports: { next: { type: "target", id: "target-a" } },
        },
      ],
    }),
  ];
}

test("reasoning node sets llama.cpp thinking fields for openai requests", async () => {
  const result = await resolveApiProxyRouteChain({
    request: request({
      body: {
        model: "public-model",
        messages: [{ role: "user", content: "hi" }],
      },
    }),
    getPipeline: getPipelineFrom(reasoningPipeline()),
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "target") {
    assert.deepEqual(result.request.body, {
      model: "public-model",
      messages: [{ role: "user", content: "hi" }],
      chat_template_kwargs: { enable_thinking: true },
      thinking_budget_tokens: 8192,
    });
    assert.equal(result.routeTrace[1]?.kind, "reasoning");
    assert.equal(result.routeTrace[1]?.detail, "high · 8192 token budget");
  }
});

test("reasoning node sets the native thinking block for anthropic requests", async () => {
  const result = await resolveApiProxyRouteChain({
    request: request({
      operation: {
        protocol: "anthropic",
        endpoint: "messages",
        routePath: "/v1/messages",
        transport: "http-json",
      },
      body: {
        model: "public-model",
        messages: [{ role: "user", content: "hi" }],
      },
    }),
    getPipeline: getPipelineFrom(reasoningPipeline()),
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "target") {
    assert.deepEqual(result.request.body, {
      model: "public-model",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 8192 },
    });
  }
});

test("apiProxyOutputLimitEditOperations caps or sets max_tokens", () => {
  const cap = { maxTokens: 4096, mode: "cap" as const };
  assert.deepEqual(
    apiProxyOutputLimitEditOperations(cap, { max_tokens: 32000 }),
    [{ kind: "set-field", enabled: true, path: "max_tokens", value: 4096 }],
  );
  assert.deepEqual(
    apiProxyOutputLimitEditOperations(cap, { max_tokens: 500 }),
    [],
  );
  assert.deepEqual(apiProxyOutputLimitEditOperations(cap, {}), [
    { kind: "set-field", enabled: true, path: "max_tokens", value: 4096 },
  ]);
  const set = { maxTokens: 4096, mode: "set" as const };
  assert.deepEqual(
    apiProxyOutputLimitEditOperations(set, { max_tokens: 500 }),
    [{ kind: "set-field", enabled: true, path: "max_tokens", value: 4096 }],
  );
  assert.deepEqual(
    apiProxyOutputLimitEditOperations(set, { max_tokens: 4096 }),
    [],
  );
});

test("output-limit node caps a runaway max_tokens mid-route", async () => {
  const pipelines = [
    pipelineRecord({
      id: "pipeline-a",
      entry: { type: "node", id: "limit" },
      nodes: [
        {
          id: "limit",
          name: "",
          type: "output-limit",
          config: { maxTokens: 4096, mode: "cap" },
          ports: { next: { type: "target", id: "target-a" } },
        },
      ],
    }),
  ];

  const result = await resolveApiProxyRouteChain({
    request: request({
      body: {
        model: "public-model",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 32000,
      },
    }),
    getPipeline: getPipelineFrom(pipelines),
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "target") {
    assert.deepEqual(result.request.body, {
      model: "public-model",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
    });
    assert.equal(result.routeTrace[1]?.kind, "output-limit");
  }
});

test("token-scale divides request limits and defers inverse usage scaling", async () => {
  const pipeline = pipelineRecord({
    id: "pipeline-a",
    entry: { type: "node", id: "scale" },
    nodes: [
      {
        id: "scale",
        name: "128k local",
        type: "token-scale",
        config: { factor: 10 },
        ports: { next: { type: "target", id: "target-a" } },
      },
    ],
  });
  const result = await resolveApiProxyRouteChain({
    request: request({
      body: {
        model: "public-model",
        max_tokens: 40_000,
        thinking: { type: "enabled", budget_tokens: 20_000 },
      },
    }),
    getPipeline: getPipelineFrom([pipeline]),
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "target") {
    assert.deepEqual(result.request.body, {
      model: "public-model",
      max_tokens: 4_000,
      thinking: { type: "enabled", budget_tokens: 2_000 },
    });
    assert.deepEqual(result.responseEffects, [
      { type: "token-scale", factor: 10 },
    ]);
    assert.equal(
      result.routeTrace[1]?.detail,
      "factor 10 · set max_tokens = 4000 (was 40000); set thinking.budget_tokens = 2000 (was 20000)",
    );
  }
});

test("context-limit continues below its estimated prompt threshold", async () => {
  const pipeline = pipelineRecord({
    id: "pipeline-a",
    entry: { type: "node", id: "guard" },
    nodes: [
      {
        id: "guard",
        name: "leave generation room",
        type: "context-limit",
        config: { thresholdTokens: 100 },
        ports: { next: { type: "target", id: "target-a" } },
      },
    ],
  });
  const result = await resolveApiProxyRouteChain({
    request: request(),
    getPipeline: getPipelineFrom([pipeline]),
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.kind, "target");
    assert.equal(result.routeTrace[1]?.kind, "context-limit");
    assert.equal(result.routeTrace[1]?.port, "next");
    assert.match(result.routeTrace[1]?.detail ?? "", /threshold 100 tokens$/);
  }
});

test("context-limit rejects at its estimated prompt threshold", async () => {
  const pipeline = pipelineRecord({
    id: "pipeline-a",
    entry: { type: "node", id: "guard" },
    nodes: [
      {
        id: "guard",
        name: "leave generation room",
        type: "context-limit",
        config: { thresholdTokens: 1 },
        ports: { next: { type: "target", id: "target-a" } },
      },
    ],
  });
  const result = await resolveApiProxyRouteChain({
    request: request(),
    getPipeline: getPipelineFrom([pipeline]),
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.diagnostic, {
      status: 400,
      code: "arriero_proxy_context_overflow",
      message: "Prompt is too long",
      param: null,
    });
    assert.equal(result.routeTrace[1]?.kind, "context-limit");
    assert.equal(result.routeTrace[1]?.port, null);
    assert.match(result.routeTrace[1]?.detail ?? "", / · rejected$/);
  }
});

test("loop-guard pushes its response effect and traces its channels", async () => {
  const guard = ApiProxyPipelineNodeSchema.parse({
    id: "guard",
    name: "Loop watch",
    type: "loop-guard",
    config: { action: "finish", toolArguments: true, noveltyThreshold: 0.2 },
    ports: { next: { type: "target", id: "target-a" } },
  });
  const pipelines = [
    pipelineRecord({
      id: "pipeline-a",
      entry: { type: "node", id: "guard" },
      nodes: [guard],
    }),
  ];

  const result = await resolveApiProxyRouteChain({
    request: request(),
    getPipeline: getPipelineFrom(pipelines),
  });

  assert.equal(result.ok, true);
  if (result.ok && result.kind === "target") {
    assert.equal(result.targetId, "target-a");
    assert.equal(result.responseEffects.length, 1);
    const effect = result.responseEffects[0];
    assert.equal(effect?.type, "loop-guard");
    if (effect?.type === "loop-guard") {
      assert.equal(effect.nodeName, "Loop watch");
      assert.equal(effect.config.action, "finish");
      assert.equal(effect.config.noveltyThreshold, 0.2);
      assert.equal(effect.config.answer, true);
      assert.equal(effect.config.reasoning, true);
      assert.equal(effect.config.toolArguments, true);
      assert.equal(effect.config.minSpanChars, 1024);
    }
    assert.deepEqual(
      result.routeTrace.map((step) => step.kind),
      ["enter-pipeline", "loop-guard"],
    );
    assert.equal(result.routeTrace[1]?.port, "next");
    assert.equal(
      result.routeTrace[1]?.detail,
      "finish · answer + reasoning + tools",
    );
  }
});

test("fusion node terminates the chain carrying panel and synthesizer refs", async () => {
  const fusion = ApiProxyPipelineNodeSchema.parse({
    id: "fuse",
    name: "Ensemble",
    type: "fusion",
    config: { minQuorum: 2 },
    ports: {
      panel: [
        { type: "target", id: "panel-a" },
        { type: "target", id: "panel-b" },
      ],
      synthesizer: { type: "target", id: "synth" },
    },
  });
  const pipelines = [
    pipelineRecord({
      id: "pipeline-a",
      entry: { type: "node", id: "replace" },
      nodes: [
        {
          id: "replace",
          name: "",
          type: "replace-text",
          config: {
            rules: [{ enabled: true, find: "bad text", replace: "good text" }],
            request: true,
            response: false,
            responseReasoning: false,
            responseToolArguments: false,
          },
          ports: { next: { type: "node", id: "fuse" } },
        },
        fusion,
      ],
    }),
  ];

  const result = await resolveApiProxyRouteChain({
    request: request(),
    getPipeline: getPipelineFrom(pipelines),
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.kind, "fusion");
  if (result.ok && result.kind === "fusion") {
    assert.equal(result.node.id, "fuse");
    assert.equal(result.node.config.minQuorum, 2);
    assert.deepEqual(result.node.ports.panel, [
      { type: "target", id: "panel-a" },
      { type: "target", id: "panel-b" },
    ]);
    assert.deepEqual(result.node.ports.synthesizer, {
      type: "target",
      id: "synth",
    });
    assert.equal(result.pipeline.id, "pipeline-a");
    assert.equal(result.textReplacementCount, 1);
    assert.deepEqual(result.request.body, {
      model: "public-model",
      messages: [{ role: "user", content: "hello good text" }],
    });
    assert.deepEqual(
      result.routeTrace.map((step) => step.kind),
      ["enter-pipeline", "replace-text", "fusion"],
    );
    assert.equal(result.routeTrace.at(-1)?.port, null);
    assert.equal(result.routeTrace.at(-1)?.detail, "fusion (2 panel)");
  }
});
