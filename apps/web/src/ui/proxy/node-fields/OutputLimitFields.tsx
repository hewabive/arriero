import type { ApiProxyOutputLimitMode } from "@arriero/core";
import { NumberInput, SegmentedControl, Stack, Text } from "@mantine/core";

import type { PipelineNodeDraftOf, PipelineNodeDraftPatch } from "../forms";
import { outputLimitModeOptions } from "./context";

export function OutputLimitFields(props: {
  node: PipelineNodeDraftOf<"output-limit">;
  update: (patch: PipelineNodeDraftPatch<"output-limit">) => void;
}) {
  const { node, update } = props;
  const caption =
    node.outputLimitMode === "cap"
      ? "Lowers max_tokens to this ceiling, never raises it — caps runaway generation while respecting smaller client requests."
      : "Forces max_tokens to this value, overriding whatever the client sent.";
  return (
    <Stack gap="sm">
      <SegmentedControl
        fullWidth
        data={outputLimitModeOptions}
        value={node.outputLimitMode}
        onChange={(value) =>
          update({ outputLimitMode: value as ApiProxyOutputLimitMode })
        }
      />
      <NumberInput
        label="Max output tokens"
        min={1}
        value={node.outputLimitMax}
        onChange={(value) =>
          update({ outputLimitMax: value === "" ? "" : Number(value) })
        }
      />
      <Text c="dimmed" size="xs">
        {caption}
      </Text>
    </Stack>
  );
}
