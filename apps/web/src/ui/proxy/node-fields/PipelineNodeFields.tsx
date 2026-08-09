import {
  assertNever,
  scaleApiProxyRequestTokenCount,
  scaleApiProxyResponseTokenCount,
} from "@arriero/core";
import { Checkbox, NumberInput, Text, TextInput } from "@mantine/core";

import { EditRequestFields } from "../edit-request-fields";
import type { PipelineNodeDraft } from "../forms";
import { TouchSelect } from "../../components/TouchCombobox";
import { ConditionFields } from "./ConditionFields";
import type { PipelineEditorContext } from "./context";
import { editorCallExitNames, editorOtherPipelines } from "./editor-helpers";
import { FusionFields } from "./FusionFields";
import { LoopGuardFields } from "./LoopGuardFields";
import { OutputLimitFields } from "./OutputLimitFields";
import { PortSelect } from "./PortSelect";
import { ReasoningFields } from "./ReasoningFields";
import { ReplaceTextFields } from "./ReplaceTextFields";

export function PipelineNodeFields(props: {
  node: PipelineNodeDraft;
  ctx: PipelineEditorContext;
}) {
  const { node, ctx } = props;
  const update = (patch: Partial<PipelineNodeDraft>) =>
    ctx.updateNode(node.id, patch);

  switch (node.type) {
    case "replace-text":
      return <ReplaceTextFields node={node} ctx={ctx} />;
    case "capture-request":
      return (
        <>
          <Checkbox
            label="Save request body"
            description="The request exactly as it arrives at this node, including changes made by earlier nodes."
            checked={node.captureRequest}
            onChange={(event) =>
              update({ captureRequest: event.currentTarget.checked })
            }
          />
          <Checkbox
            label="Save response body"
            description="The upstream reply for this request, written once it completes."
            checked={node.captureResponse}
            onChange={(event) =>
              update({ captureResponse: event.currentTarget.checked })
            }
          />
          <PortSelect
            label="Next"
            ctx={ctx}
            excludeNodeId={node.id}
            value={node.portNext}
            onChange={(portNext) => update({ portNext })}
          />
        </>
      );
    case "edit-request":
      return (
        <>
          <EditRequestFields node={node} updateNode={ctx.updateNode} />
          <PortSelect
            label="Next"
            ctx={ctx}
            excludeNodeId={node.id}
            value={node.portNext}
            onChange={(portNext) => update({ portNext })}
          />
        </>
      );
    case "reasoning":
      return (
        <>
          <ReasoningFields node={node} update={update} />
          <PortSelect
            label="Next"
            ctx={ctx}
            excludeNodeId={node.id}
            value={node.portNext}
            onChange={(portNext) => update({ portNext })}
          />
        </>
      );
    case "output-limit":
      return (
        <>
          <OutputLimitFields node={node} update={update} />
          <PortSelect
            label="Next"
            ctx={ctx}
            excludeNodeId={node.id}
            value={node.portNext}
            onChange={(portNext) => update({ portNext })}
          />
        </>
      );
    case "context-limit":
      return (
        <>
          <NumberInput
            label="Reject at estimated prompt tokens"
            description="Returns a context-overflow error at or above this local estimate. Set it below the real context size to leave room for generation."
            min={1}
            max={100_000_000}
            value={node.contextLimitThreshold}
            onChange={(value) =>
              update({
                contextLimitThreshold: typeof value === "number" ? value : "",
              })
            }
          />
          <Text c="dimmed" size="xs">
            The estimate covers prompt messages, system text and tools. It is a
            fast approximation, so keep a safety margin for tokenizer
            differences and output tokens.
          </Text>
          <PortSelect
            label="Next"
            ctx={ctx}
            excludeNodeId={node.id}
            value={node.portNext}
            onChange={(portNext) => update({ portNext })}
          />
        </>
      );
    case "token-scale": {
      const factor = node.tokenScaleFactor === "" ? 1 : node.tokenScaleFactor;
      return (
        <>
          <NumberInput
            label="Client-visible / real tokens"
            description="Request token limits are divided by this factor; response usage is multiplied by it."
            min={0.000001}
            max={1_000_000}
            decimalScale={6}
            value={node.tokenScaleFactor}
            onChange={(value) =>
              update({
                tokenScaleFactor: typeof value === "number" ? value : "",
              })
            }
          />
          <Text c="dimmed" size="xs">
            {factor === 1
              ? "Factor 1 leaves limits and usage unchanged."
              : `Example: max_tokens 40000 → ${scaleApiProxyRequestTokenCount(40_000, factor)}; usage 10000 → ${scaleApiProxyResponseTokenCount(10_000, factor)}.`}
          </Text>
          <PortSelect
            label="Next"
            ctx={ctx}
            excludeNodeId={node.id}
            value={node.portNext}
            onChange={(portNext) => update({ portNext })}
          />
        </>
      );
    }
    case "strip-attribution":
      return (
        <>
          <Text c="dimmed" size="sm">
            Removes Claude Code&apos;s per-request billing/attribution block and
            pins volatile cch hashes, keeping the upstream KV-cache prefix and
            any downstream cache key stable. No configuration.
          </Text>
          <PortSelect
            label="Next"
            ctx={ctx}
            excludeNodeId={node.id}
            value={node.portNext}
            onChange={(portNext) => update({ portNext })}
          />
        </>
      );
    case "cache":
      return (
        <>
          <Text c="dimmed" size="sm">
            Serves an identical request from a saved response instead of the
            upstream — a hit short-circuits routing, lease and the model
            entirely. The key hashes the request body at this node (excluding
            stream flags), the model id and the namespace. Non-streaming only
            (embeddings, rerank, non-stream chat); place a Strip CC attribution
            node before it for a stable key.
          </Text>
          <NumberInput
            label="TTL (seconds)"
            description="0 = never expires (until evicted)."
            min={0}
            value={node.cacheTtlSeconds}
            onChange={(value) =>
              update({
                cacheTtlSeconds: typeof value === "number" ? value : "",
              })
            }
          />
          <TextInput
            label="Namespace"
            description="Optional. Separates entries when one model id is routed to different upstreams."
            value={node.cacheNamespace}
            onChange={(event) => {
              const cacheNamespace = event.currentTarget.value;
              update({ cacheNamespace });
            }}
          />
          <PortSelect
            label="Next (on miss)"
            ctx={ctx}
            excludeNodeId={node.id}
            value={node.portNext}
            onChange={(portNext) => update({ portNext })}
          />
        </>
      );
    case "loop-guard":
      return (
        <>
          <LoopGuardFields node={node} update={update} />
          <PortSelect
            label="Next"
            ctx={ctx}
            excludeNodeId={node.id}
            value={node.portNext}
            onChange={(portNext) => update({ portNext })}
          />
        </>
      );
    case "condition":
      return <ConditionFields node={node} ctx={ctx} update={update} />;
    case "call":
      return (
        <>
          <TouchSelect
            label="Pipeline"
            data={editorOtherPipelines(ctx).map((pipeline) => ({
              value: pipeline.id,
              label: pipeline.name,
            }))}
            value={node.callPipelineId}
            searchable
            onChange={(value) =>
              update({ callPipelineId: value || null, callPorts: {} })
            }
          />
          {editorCallExitNames(ctx, node).map((exitName) => (
            <PortSelect
              key={exitName}
              label={`Exit "${exitName}" →`}
              ctx={ctx}
              excludeNodeId={node.id}
              value={node.callPorts[exitName] ?? null}
              onChange={(value) =>
                update({ callPorts: { ...node.callPorts, [exitName]: value } })
              }
            />
          ))}
          {node.callPipelineId &&
            editorCallExitNames(ctx, node).length === 0 && (
              <Text c="dimmed" size="sm">
                The called pipeline has no exit nodes — requests either end at a
                target inside it or the route fails.
              </Text>
            )}
        </>
      );
    case "fusion":
      return <FusionFields node={node} ctx={ctx} update={update} />;
    case "exit":
      return (
        <TextInput
          label="Exit name"
          description="Call nodes referencing this pipeline route onward by this name."
          value={node.exitName}
          onChange={(event) => {
            const exitName = event.currentTarget.value;
            update({ exitName });
          }}
        />
      );
    default:
      return assertNever(node.type);
  }
}
