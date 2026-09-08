import {
  type ApiProxyPipelineNode,
  type ApiProxyPipelineRecord,
  type ApiProxyPortRef,
} from "@arriero/core";

type CallFrame = {
  ownerPipeline: ApiProxyPipelineRecord;
  node: Extract<ApiProxyPipelineNode, { type: "call" }>;
};

export function uniqueTokenCountTarget(input: {
  node: ApiProxyPipelineNode;
  pipeline: ApiProxyPipelineRecord;
  callStack: CallFrame[];
  getPipeline: (id: string) => ApiProxyPipelineRecord | null;
}): string | null {
  const targets = new Set<string>();
  const visited = new Set<string>();
  let complete = true;
  let budget = 4096;

  const visit = (
    ref: ApiProxyPortRef | null,
    pipeline: ApiProxyPipelineRecord,
    stack: CallFrame[],
  ): void => {
    if (!ref || --budget < 0 || stack.length > 8) {
      complete = false;
      return;
    }
    if (ref.type === "target") {
      targets.add(ref.id);
      return;
    }
    const key = JSON.stringify([
      pipeline.id,
      ref,
      stack.map((frame) => [frame.ownerPipeline.id, frame.node.id]),
    ]);
    if (visited.has(key)) return;
    visited.add(key);
    if (ref.type === "pipeline") {
      const callee = input.getPipeline(ref.id);
      if (!callee?.enabled) {
        complete = false;
        return;
      }
      visit(callee.entry, callee, stack);
      return;
    }
    const node = pipeline.nodes.find((item) => item.id === ref.id);
    if (!node || node.type === "fusion") {
      complete = false;
      return;
    }
    if (node.type === "exit") {
      const frame = stack.at(-1);
      if (!frame) {
        complete = false;
        return;
      }
      visit(
        frame.node.ports[node.config.exitName] ?? null,
        frame.ownerPipeline,
        stack.slice(0, -1),
      );
      return;
    }
    if (node.type === "call") {
      const callee = input.getPipeline(node.config.pipelineId);
      if (!callee?.enabled) {
        complete = false;
        return;
      }
      visit(callee.entry, callee, [
        ...stack,
        { ownerPipeline: pipeline, node },
      ]);
      return;
    }
    if (node.type === "condition") {
      visit(node.ports.true, pipeline, stack);
      visit(node.ports.false, pipeline, stack);
      return;
    }
    visit(node.ports.next, pipeline, stack);
  };

  visit({ type: "node", id: input.node.id }, input.pipeline, input.callStack);
  return complete && targets.size === 1 ? [...targets][0]! : null;
}
