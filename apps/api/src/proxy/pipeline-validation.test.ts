import assert from "node:assert/strict";
import test from "node:test";

import type { ApiProxyPipelineNode } from "@arriero/core";

import {
  collectApiProxyPipelineRefs,
  validateApiProxyPipelineGraph,
  type ApiProxyPipelineGraph,
} from "./pipeline-validation.js";

function graph(input: Partial<ApiProxyPipelineGraph>): ApiProxyPipelineGraph {
  return {
    id: "self",
    name: "Self",
    entry: null,
    nodes: [],
    ...input,
  };
}

function context(
  pipelines: ApiProxyPipelineGraph[] = [],
  targets: string[] = ["target-a", "target-b"],
) {
  return {
    getPipeline: (id: string) =>
      pipelines.find((pipeline) => pipeline.id === id) ?? null,
    hasTarget: (id: string) => targets.includes(id),
  };
}

function exitNode(id: string, exitName: string): ApiProxyPipelineNode {
  return { id, name: "", type: "exit", config: { exitName } };
}

test("accepts a valid graph", () => {
  const error = validateApiProxyPipelineGraph(
    graph({
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
              pattern: "x",
              regex: true,
              caseSensitive: false,
            },
          },
          ports: {
            true: { type: "target", id: "target-a" },
            false: { type: "target", id: "target-b" },
          },
        },
      ],
    }),
    context(),
  );
  assert.equal(error, null);
});

test("rejects duplicate node ids", () => {
  const error = validateApiProxyPipelineGraph(
    graph({
      nodes: [exitNode("n1", "done"), exitNode("n1", "other")],
    }),
    context(),
  );
  assert.match(error ?? "", /duplicate node id/);
});

test("rejects refs to missing nodes and targets", () => {
  assert.match(
    validateApiProxyPipelineGraph(
      graph({ entry: { type: "node", id: "ghost" } }),
      context(),
    ) ?? "",
    /missing node "ghost"/,
  );
  assert.match(
    validateApiProxyPipelineGraph(
      graph({ entry: { type: "target", id: "ghost" } }),
      context(),
    ) ?? "",
    /missing target "ghost"/,
  );
  assert.match(
    validateApiProxyPipelineGraph(
      graph({ entry: { type: "pipeline", id: "ghost" } }),
      context(),
    ) ?? "",
    /missing pipeline "ghost"/,
  );
});

test("rejects invalid regex patterns", () => {
  const error = validateApiProxyPipelineGraph(
    graph({
      nodes: [
        {
          id: "cond",
          name: "",
          type: "condition",
          config: {
            predicate: {
              type: "text-match",
              scope: "any-message",
              pattern: "(",
              regex: true,
              caseSensitive: false,
            },
          },
          ports: { true: null, false: null },
        },
      ],
    }),
    context(),
  );
  assert.match(error ?? "", /invalid regex/);
});

test("rejects node cycles inside the graph", () => {
  const error = validateApiProxyPipelineGraph(
    graph({
      nodes: [
        {
          id: "a",
          name: "",
          type: "replace-text",
          config: {
            rules: [],
            request: true,
            response: false,
            responseReasoning: false,
            responseToolArguments: false,
          },
          ports: { next: { type: "node", id: "b" } },
        },
        {
          id: "b",
          name: "",
          type: "replace-text",
          config: {
            rules: [],
            request: true,
            response: false,
            responseReasoning: false,
            responseToolArguments: false,
          },
          ports: { next: { type: "node", id: "a" } },
        },
      ],
    }),
    context(),
  );
  assert.match(error ?? "", /cycle/);
});

test("rejects circular pipeline references through calls", () => {
  const other = graph({
    id: "other",
    name: "Other",
    nodes: [
      {
        id: "call-self",
        name: "",
        type: "call",
        config: { pipelineId: "self" },
        ports: {},
      },
    ],
  });
  const error = validateApiProxyPipelineGraph(
    graph({
      nodes: [
        {
          id: "call-other",
          name: "",
          type: "call",
          config: { pipelineId: "other" },
          ports: {},
        },
      ],
    }),
    context([other]),
  );
  assert.match(error ?? "", /references itself/);
});

test("rejects wiring an unknown exit of the callee", () => {
  const callee = graph({
    id: "fn",
    name: "Fn",
    nodes: [exitNode("e", "done")],
  });
  const error = validateApiProxyPipelineGraph(
    graph({
      nodes: [
        {
          id: "call-fn",
          name: "",
          type: "call",
          config: { pipelineId: "fn" },
          ports: { ghost: { type: "target", id: "target-a" } },
        },
      ],
    }),
    context([callee]),
  );
  assert.match(error ?? "", /unknown exit "ghost"/);
});

test("accepts exits reachable through a jumped-to pipeline", () => {
  const tail = graph({
    id: "tail",
    name: "Tail",
    nodes: [exitNode("e", "done")],
  });
  const callee = graph({
    id: "fn",
    name: "Fn",
    entry: { type: "pipeline", id: "tail" },
  });
  const error = validateApiProxyPipelineGraph(
    graph({
      nodes: [
        {
          id: "call-fn",
          name: "",
          type: "call",
          config: { pipelineId: "fn" },
          ports: { done: { type: "target", id: "target-a" } },
        },
      ],
    }),
    context([callee, tail]),
  );
  assert.equal(error, null);
});

test("collectApiProxyPipelineRefs gathers pipeline and target refs", () => {
  const refs = collectApiProxyPipelineRefs(
    graph({
      entry: { type: "pipeline", id: "p1" },
      nodes: [
        {
          id: "call",
          name: "",
          type: "call",
          config: { pipelineId: "p2" },
          ports: { done: { type: "target", id: "t1" } },
        },
      ],
    }),
  );
  assert.deepEqual([...refs.pipelineIds].sort(), ["p1", "p2"]);
  assert.deepEqual([...refs.targetIds], ["t1"]);
});
