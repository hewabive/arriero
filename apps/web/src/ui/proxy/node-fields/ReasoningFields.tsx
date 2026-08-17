import type { ApiProxyReasoningEffort } from "@arriero/core";
import { NumberInput, SegmentedControl, Stack, Text } from "@mantine/core";

import type { PipelineNodeDraftOf, PipelineNodeDraftPatch } from "../forms";
import { reasoningEffortOptions } from "./context";

function caption(node: PipelineNodeDraftOf<"reasoning">): string {
  switch (node.reasoningEffort) {
    case "auto":
      return "Follows the client-requested effort; the upstream reasoning profile maps it to the model's native interface.";
    case "off":
      return "Model thinking is disabled.";
    case "custom": {
      const budget =
        node.reasoningCustomBudget === "" ? -1 : node.reasoningCustomBudget;
      return budget < 0
        ? "Overrides the client effort with an unlimited thinking budget."
        : `Overrides the client effort with a ~${budget}-token thinking budget.`;
    }
    default:
      return `Overrides the client effort with "${node.reasoningEffort}"; the upstream reasoning profile maps it to the model's native interface.`;
  }
}

export function ReasoningFields(props: {
  node: PipelineNodeDraftOf<"reasoning">;
  update: (patch: PipelineNodeDraftPatch<"reasoning">) => void;
}) {
  const { node, update } = props;
  return (
    <Stack gap="sm">
      <SegmentedControl
        fullWidth
        data={reasoningEffortOptions}
        value={node.reasoningEffort}
        onChange={(value) =>
          update({ reasoningEffort: value as ApiProxyReasoningEffort })
        }
      />
      {node.reasoningEffort === "custom" && (
        <NumberInput
          label="Thinking budget (tokens)"
          description="-1 = unlimited"
          min={-1}
          value={node.reasoningCustomBudget}
          onChange={(value) =>
            update({
              reasoningCustomBudget: value === "" ? "" : Number(value),
            })
          }
        />
      )}
      <Text c="dimmed" size="xs">
        {caption(node)}
      </Text>
    </Stack>
  );
}
