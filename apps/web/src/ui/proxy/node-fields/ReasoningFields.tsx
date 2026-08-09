import {
  resolveApiProxyReasoning,
  type ApiProxyReasoningEffort,
} from "@arriero/core";
import { NumberInput, SegmentedControl, Stack, Text } from "@mantine/core";

import type { PipelineNodeDraftOf, PipelineNodeDraftPatch } from "../forms";
import { reasoningEffortOptions } from "./context";

export function ReasoningFields(props: {
  node: PipelineNodeDraftOf<"reasoning">;
  update: (patch: PipelineNodeDraftPatch<"reasoning">) => void;
}) {
  const { node, update } = props;
  const resolved = resolveApiProxyReasoning({
    effort: node.reasoningEffort,
    customBudgetTokens:
      node.reasoningCustomBudget === "" ? -1 : node.reasoningCustomBudget,
  });
  const caption = !resolved.enableThinking
    ? "Model thinking is disabled."
    : resolved.budget === null || resolved.budget < 0
      ? "Thinking on, unlimited token budget."
      : `Thinking on, ~${resolved.budget} reasoning-token budget.`;
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
        {caption}
      </Text>
    </Stack>
  );
}
