import assert from "node:assert/strict";
import test from "node:test";

import {
  collectApiProxyRouteHoles,
  type ApiProxyPipelineNode,
  type ApiProxyRoutePipelineShape,
} from "@arriero/core";

import {
  validateApiProxyModelRouteBinding,
  validateApiProxyPipelineRouteCompleteness,
} from "./pipeline-validation.js";

function pipeline(
  input: Partial<ApiProxyRoutePipelineShape> & { id: string },
): ApiProxyRoutePipelineShape {
  return { name: input.id, entry: null, nodes: [], ...input };
}

function lookup(pipelines: ApiProxyRoutePipelineShape[]) {
  return (id: string) => pipelines.find((item) => item.id === id) ?? null;
}

function replaceNode(id: string, next: unknown): ApiProxyPipelineNode {
  return {
    id,
    name: "",
    type: "replace-text",
    config: {
      rules: [],
      request: true,
      response: false,
      responseReasoning: false,
      responseToolArguments: false,
    },
    ports: { next: next as never },
  };
}

function conditionNode(
  id: string,
  ports: { true: unknown; false: unknown },
): ApiProxyPipelineNode {
  return {
    id,
    name: "",
    type: "condition",
    config: {
      predicate: {
        type: "text-match",
        scope: "any-message",
        pattern: "x",
        regex: false,
        caseSensitive: false,
      },
    },
    ports: ports as never,
  };
}

function callNode(
  id: string,
  pipelineId: string,
  ports: Record<string, unknown>,
): ApiProxyPipelineNode {
  return {
    id,
    name: "",
    type: "call",
    config: { pipelineId },
    ports: ports as never,
  };
}

function exitNode(id: string, exitName: string): ApiProxyPipelineNode {
  return { id, name: "", type: "exit", config: { exitName } };
}

const target = { type: "target", id: "target-a" } as const;

test("complete chain to a target has no holes", () => {
  const head = pipeline({
    id: "head",
    entry: { type: "node", id: "r1" },
    nodes: [replaceNode("r1", target)],
  });
  assert.deepEqual(collectApiProxyRouteHoles("head", lookup([head])), []);
});

test("escaping exit is a hole", () => {
  const head = pipeline({
    id: "head",
    entry: { type: "node", id: "x" },
    nodes: [exitNode("x", "done")],
  });
  const holes = collectApiProxyRouteHoles("head", lookup([head]));
  assert.equal(holes.length, 1);
  assert.match(holes[0]!.message, /exit "done".*escapes the route/);
  assert.equal(holes[0]!.nodeId, "x");
});

test("unwired entry and condition port are holes", () => {
  const head = pipeline({
    id: "head",
    entry: { type: "node", id: "cond" },
    nodes: [conditionNode("cond", { true: target, false: null })],
  });
  const holes = collectApiProxyRouteHoles("head", lookup([head]));
  assert.equal(holes.length, 1);
  assert.match(holes[0]!.message, /port "false".*is unwired/);

  const empty = pipeline({ id: "empty", entry: null, nodes: [] });
  const entryHoles = collectApiProxyRouteHoles("empty", lookup([empty]));
  assert.equal(entryHoles.length, 1);
  assert.match(entryHoles[0]!.message, /entry in pipeline "empty" is unwired/);
});

test("call with wired exits completes; missing wiring is a hole at the call node", () => {
  const callee = pipeline({
    id: "callee",
    entry: { type: "node", id: "cond" },
    nodes: [
      conditionNode("cond", {
        true: { type: "node", id: "ok" },
        false: { type: "node", id: "skip" },
      }),
      exitNode("ok", "matched"),
      exitNode("skip", "missed"),
    ],
  });
  const wired = pipeline({
    id: "head",
    entry: { type: "node", id: "c1" },
    nodes: [callNode("c1", "callee", { matched: target, missed: target })],
  });
  assert.deepEqual(
    collectApiProxyRouteHoles("head", lookup([wired, callee])),
    [],
  );

  const partial = pipeline({
    id: "head",
    entry: { type: "node", id: "c1" },
    nodes: [callNode("c1", "callee", { matched: target })],
  });
  const holes = collectApiProxyRouteHoles("head", lookup([partial, callee]));
  assert.equal(holes.length, 1);
  assert.match(holes[0]!.message, /call node c1.*no wiring for exit "missed"/);
  assert.equal(holes[0]!.pipelineId, "head");
  assert.equal(holes[0]!.nodeId, "c1");
});

test("tail jump into a pipeline with an escaping exit is a hole there", () => {
  const tail = pipeline({
    id: "tail",
    entry: { type: "node", id: "x" },
    nodes: [exitNode("x", "done")],
  });
  const head = pipeline({
    id: "head",
    entry: { type: "pipeline", id: "tail" },
    nodes: [],
  });
  const holes = collectApiProxyRouteHoles("head", lookup([head, tail]));
  assert.equal(holes.length, 1);
  assert.equal(holes[0]!.pipelineId, "tail");
  assert.match(holes[0]!.message, /escapes the route/);
});

test("exit survives a tail jump inside a call", () => {
  const inner = pipeline({
    id: "inner",
    entry: { type: "node", id: "x" },
    nodes: [exitNode("x", "done")],
  });
  const middle = pipeline({
    id: "middle",
    entry: { type: "pipeline", id: "inner" },
    nodes: [],
  });
  const head = pipeline({
    id: "head",
    entry: { type: "node", id: "c1" },
    nodes: [callNode("c1", "middle", { done: target })],
  });
  assert.deepEqual(
    collectApiProxyRouteHoles("head", lookup([head, middle, inner])),
    [],
  );
});

test("unreachable orphan exit is not a hole", () => {
  const head = pipeline({
    id: "head",
    entry: { type: "node", id: "r1" },
    nodes: [replaceNode("r1", target), exitNode("orphan", "done")],
  });
  assert.deepEqual(collectApiProxyRouteHoles("head", lookup([head])), []);
});

test("model binding to an incomplete pipeline is rejected", () => {
  const head = pipeline({
    id: "head",
    name: "Test",
    entry: { type: "node", id: "x" },
    nodes: [exitNode("x", "done")],
  });
  const error = validateApiProxyModelRouteBinding({
    routeTo: { type: "pipeline", id: "head" },
    getPipeline: lookup([head]),
  });
  assert.match(error ?? "", /pipeline "Test" cannot serve a model/);
  assert.match(error ?? "", /exit "done"/);

  assert.equal(
    validateApiProxyModelRouteBinding({
      routeTo: { type: "target", id: "target-a" },
      getPipeline: lookup([head]),
    }),
    null,
  );
});

test("saving a model-bound pipeline with a hole is rejected", () => {
  const candidate = pipeline({
    id: "head",
    name: "Route",
    entry: { type: "node", id: "x" },
    nodes: [exitNode("x", "done")],
  });
  const error = validateApiProxyPipelineRouteCompleteness({
    candidate,
    models: [
      { modelId: "a-fast-chat", routeTo: { type: "pipeline", id: "head" } },
    ],
    getPipeline: lookup([]),
  });
  assert.match(error ?? "", /serves model\(s\) "a-fast-chat"/);
});

test("saving a pipeline that breaks another route through a tail jump is rejected", () => {
  const head = pipeline({
    id: "head",
    name: "Route",
    entry: { type: "pipeline", id: "tail" },
    nodes: [],
  });
  const candidate = pipeline({
    id: "tail",
    name: "Tail",
    entry: { type: "node", id: "x" },
    nodes: [exitNode("x", "done")],
  });
  const error = validateApiProxyPipelineRouteCompleteness({
    candidate,
    models: [
      { modelId: "a-fast-chat", routeTo: { type: "pipeline", id: "head" } },
    ],
    getPipeline: lookup([head]),
  });
  assert.match(
    error ?? "",
    /would break the route of model\(s\) "a-fast-chat"/,
  );
  assert.match(error ?? "", /through pipeline "Route"/);
});

test("saving an unrelated pipeline ignores broken routes elsewhere", () => {
  const broken = pipeline({
    id: "broken",
    entry: { type: "node", id: "x" },
    nodes: [exitNode("x", "done")],
  });
  const candidate = pipeline({
    id: "other",
    entry: { type: "node", id: "r1" },
    nodes: [replaceNode("r1", target)],
  });
  assert.equal(
    validateApiProxyPipelineRouteCompleteness({
      candidate,
      models: [
        {
          modelId: "broken-model",
          routeTo: { type: "pipeline", id: "broken" },
        },
      ],
      getPipeline: lookup([broken]),
    }),
    null,
  );
});

test("complete pipeline with bound models passes", () => {
  const candidate = pipeline({
    id: "head",
    entry: { type: "node", id: "c1" },
    nodes: [
      conditionNode("c1", {
        true: target,
        false: { type: "target", id: "target-b" },
      }),
    ],
  });
  assert.equal(
    validateApiProxyPipelineRouteCompleteness({
      candidate,
      models: [
        { modelId: "a-fast-chat", routeTo: { type: "pipeline", id: "head" } },
      ],
      getPipeline: lookup([]),
    }),
    null,
  );
});
