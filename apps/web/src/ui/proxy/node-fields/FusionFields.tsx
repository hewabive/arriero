import {
  ActionIcon,
  Button,
  Group,
  NumberInput,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
import { Plus, Trash2 } from "lucide-react";

import type {
  PipelineNodeDraftOf,
  PipelineNodeDraftPatch,
  PortValue,
} from "../forms";
import type { PipelineEditorContext } from "./context";
import { PortSelect } from "./PortSelect";

export function FusionFields(props: {
  node: PipelineNodeDraftOf<"fusion">;
  ctx: PipelineEditorContext;
  update: (patch: PipelineNodeDraftPatch<"fusion">) => void;
}) {
  const { node, ctx, update } = props;
  const setPanel = (index: number, value: PortValue) =>
    update({
      fusionPanel: node.fusionPanel.map((current, i) =>
        i === index ? value : current,
      ),
    });
  return (
    <>
      <Text c="dimmed" size="sm">
        Fans the request to every panel branch in parallel, then routes the
        original request plus the collected answers to the synthesizer branch.
        Each branch follows normal pipeline rules until it reaches a target.
      </Text>
      <Stack gap="xs">
        <Text size="sm" fw={500}>
          Panel branches
        </Text>
        {node.fusionPanel.map((value, index) => (
          <Group key={index} gap="xs" wrap="nowrap" align="flex-end">
            <div style={{ flex: 1 }}>
              <PortSelect
                label={`Panel ${index + 1} →`}
                ctx={ctx}
                excludeNodeId={node.id}
                value={value}
                onChange={(next) => setPanel(index, next)}
              />
            </div>
            <ActionIcon
              variant="subtle"
              color="red"
              disabled={node.fusionPanel.length <= 2}
              onClick={() =>
                update({
                  fusionPanel: node.fusionPanel.filter((_, i) => i !== index),
                })
              }
              aria-label="Remove panel branch"
            >
              <Trash2 size={16} />
            </ActionIcon>
          </Group>
        ))}
        <Button
          variant="light"
          size="xs"
          leftSection={<Plus size={14} />}
          onClick={() => update({ fusionPanel: [...node.fusionPanel, null] })}
          style={{ alignSelf: "flex-start" }}
        >
          Add panel branch
        </Button>
      </Stack>
      <PortSelect
        label="Synthesizer →"
        ctx={ctx}
        excludeNodeId={node.id}
        value={node.fusionSynthesizer}
        onChange={(fusionSynthesizer) => update({ fusionSynthesizer })}
      />
      <NumberInput
        label="Minimum quorum"
        description="Fewer surviving panel answers fails the node. With a quorum of 1 and a single survivor, its answer is returned without the synthesizer."
        min={1}
        value={node.fusionMinQuorum}
        onChange={(value) =>
          update({
            fusionMinQuorum: typeof value === "number" ? value : "",
          })
        }
      />
      <Textarea
        label="Synthesizer prompt"
        description="System instruction for the synthesizer branch."
        autosize
        minRows={3}
        value={node.fusionSynthesizerPrompt}
        onChange={(event) => {
          const fusionSynthesizerPrompt = event.currentTarget.value;
          update({ fusionSynthesizerPrompt });
        }}
      />
      <Textarea
        label="Answers preamble"
        description="Leads the user message that carries the panel answers to the synthesizer."
        autosize
        minRows={2}
        value={node.fusionAnswersTemplate}
        onChange={(event) => {
          const fusionAnswersTemplate = event.currentTarget.value;
          update({ fusionAnswersTemplate });
        }}
      />
    </>
  );
}
