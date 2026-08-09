import type { ApiProxyLoopGuardAction } from "@arriero/core";
import {
  Checkbox,
  Group,
  NumberInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";

import type { PipelineNodeDraftOf, PipelineNodeDraftPatch } from "../forms";

const actionOptions: Array<{ value: ApiProxyLoopGuardAction; label: string }> =
  [
    { value: "observe", label: "Observe" },
    { value: "finish", label: "Finish generation" },
  ];

export function LoopGuardFields(props: {
  node: PipelineNodeDraftOf<"loop-guard">;
  update: (patch: PipelineNodeDraftPatch<"loop-guard">) => void;
}) {
  const { node, update } = props;
  const numberField = (
    key:
      | "loopGuardMinSpanChars"
      | "loopGuardNoveltyThreshold"
      | "loopGuardCompressionThreshold"
      | "loopGuardEntropyThreshold"
      | "loopGuardPeriodMinRepeats"
      | "loopGuardNearMissRatio",
    label: string,
    description: string,
    options: { min?: number; max?: number; decimalScale?: number } = {},
  ) => (
    <NumberInput
      label={label}
      description={description}
      value={node[key]}
      onChange={(value) => update({ [key]: value === "" ? "" : Number(value) })}
      {...options}
    />
  );
  return (
    <Stack gap="sm">
      <SegmentedControl
        fullWidth
        data={actionOptions}
        value={node.loopGuardAction}
        onChange={(value) =>
          update({ loopGuardAction: value as ApiProxyLoopGuardAction })
        }
      />
      <Text c="dimmed" size="xs">
        {node.loopGuardAction === "observe"
          ? "Watches the response for repetition loops and records artifacts only — the stream is never touched. Use this first to calibrate thresholds via Request history."
          : "On a confirmed loop the stream is closed with a normal finish (finish_reason length / max_tokens), the upstream request is stopped and the response is excluded from caching. Streaming OpenAI chat and Anthropic replies only; other shapes fall back to observing."}
      </Text>
      <Group gap="lg">
        <Checkbox
          label="Answer"
          checked={node.loopGuardAnswer}
          onChange={(event) =>
            update({ loopGuardAnswer: event.currentTarget.checked })
          }
        />
        <Checkbox
          label="Reasoning"
          checked={node.loopGuardReasoning}
          onChange={(event) =>
            update({ loopGuardReasoning: event.currentTarget.checked })
          }
        />
        <Checkbox
          label="Tool arguments"
          checked={node.loopGuardToolArguments}
          onChange={(event) =>
            update({ loopGuardToolArguments: event.currentTarget.checked })
          }
        />
      </Group>
      <TextInput
        label="Marker text"
        description="Appended to the visible answer before the synthetic finish so the user sees why generation stopped. Empty disables the marker."
        value={node.loopGuardMarkerText}
        onChange={(event) => {
          const loopGuardMarkerText = event.currentTarget.value;
          update({ loopGuardMarkerText });
        }}
      />
      <Group gap="lg">
        <Checkbox
          label="Save trigger artifact"
          checked={node.loopGuardCaptureTrigger}
          onChange={(event) =>
            update({ loopGuardCaptureTrigger: event.currentTarget.checked })
          }
        />
        <Checkbox
          label="Save near-miss artifact"
          checked={node.loopGuardCaptureNearMiss}
          onChange={(event) =>
            update({ loopGuardCaptureNearMiss: event.currentTarget.checked })
          }
        />
      </Group>
      {numberField(
        "loopGuardMinSpanChars",
        "Arming span (chars)",
        "Detection stays off until a channel has produced this much text.",
        { min: 256, max: 65_536 },
      )}
      {numberField(
        "loopGuardPeriodMinRepeats",
        "Period repeats",
        "Exact phrase repetitions inside the window needed to count as a loop.",
        { min: 3, max: 1000 },
      )}
      {numberField(
        "loopGuardNoveltyThreshold",
        "Novelty threshold",
        "Share of new 16-char fragments in the latest window; at or below this the text is considered looping.",
        { min: 0, max: 1, decimalScale: 3 },
      )}
      {numberField(
        "loopGuardCompressionThreshold",
        "Compression threshold",
        "Deflate ratio of the recent tail; degenerate repetition compresses below this.",
        { min: 0, max: 1, decimalScale: 3 },
      )}
      {numberField(
        "loopGuardEntropyThreshold",
        "Entropy threshold (bits/char)",
        "Character entropy of the recent tail; token babble drops below this while normal text stays near 4+.",
        { min: 0, max: 8, decimalScale: 2 },
      )}
      {numberField(
        "loopGuardNearMissRatio",
        "Near-miss ratio",
        "Fraction of the trigger score that records a calibration near-miss artifact.",
        { min: 0, max: 1, decimalScale: 2 },
      )}
    </Stack>
  );
}
