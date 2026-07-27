import type {
  ApiProxyModelRecord,
  ApiProxyPipelineRecord,
  ApiProxyRouteTraceStep,
  ApiProxySourceRecord,
  ApiProxyTargetRecord,
} from "@arriero/core";
import {
  ActionIcon,
  Badge,
  Button,
  Code,
  Group,
  Menu,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { ArrowLeft, Plus, Save, Trash2 } from "lucide-react";
import { useState } from "react";

import { PipelineCanvas } from "./canvas/PipelineCanvas";
import type { PipelineDraft, PipelineNodeDraft } from "./forms";
import {
  addNodeToDraft,
  addPipelineNodeToDraft,
  removeNodeFromDraft,
  unboundTargetValue,
} from "./forms";
import {
  PipelineNodeFields,
  editorPortOptions,
  pipelineNodeTypeLabel,
  pipelineNodeTypeOptions,
  type PipelineEditorContext,
} from "./node-fields/index";
import { TouchSelect } from "../components/TouchCombobox";

export type PipelinePanelProps = {
  mode: "create" | "edit";
  pipelineId: string | null;
  draft: PipelineDraft;
  targets: ApiProxyTargetRecord[];
  pipelines: ApiProxyPipelineRecord[];
  sources: ApiProxySourceRecord[];
  models: ApiProxyModelRecord[];
  busy: boolean;
  explainTrace: ApiProxyRouteTraceStep[] | null;
  backLabel?: string;
  onBack: () => void;
  onSave: () => void;
  onDraftChange: (draft: PipelineDraft) => void;
  onOpenPipeline: (pipelineId: string) => void;
};

export function PipelinePanel(props: PipelinePanelProps) {
  const [view, setView] = useState<"canvas" | "form">("canvas");

  const ctx: PipelineEditorContext = {
    draft: props.draft,
    pipelineId: props.pipelineId,
    targets: props.targets,
    pipelines: props.pipelines,
    sources: props.sources,
    models: props.models,
    updateNode: (nodeId, patch) => {
      props.onDraftChange({
        ...props.draft,
        nodes: props.draft.nodes.map((node) =>
          node.id === nodeId ? { ...node, ...patch } : node,
        ),
      });
    },
  };

  const addNode = (type: PipelineNodeDraft["type"]) => {
    props.onDraftChange(addNodeToDraft(props.draft, type));
  };

  const otherPipelines = props.pipelines.filter(
    (pipeline) => pipeline.id !== props.pipelineId,
  );

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Group justify="space-between" wrap="wrap">
          <Group gap="xs" wrap="wrap">
            <Button
              variant="subtle"
              leftSection={<ArrowLeft size={16} />}
              onClick={props.onBack}
            >
              {props.backLabel ?? "Back"}
            </Button>
            <TextInput
              placeholder="Pipeline name"
              value={props.draft.name}
              onChange={(event) => {
                const name = event.currentTarget.value;
                props.onDraftChange({ ...props.draft, name });
              }}
            />
            <Switch
              label="Enabled"
              checked={props.draft.enabled}
              onChange={(event) => {
                const enabled = event.currentTarget.checked;
                props.onDraftChange({ ...props.draft, enabled });
              }}
            />
            {view === "form" && (
              <TouchSelect
                placeholder="Entry"
                data={editorPortOptions(ctx, null)}
                value={props.draft.entryValue ?? unboundTargetValue}
                searchable
                miw={200}
                onChange={(value) =>
                  props.onDraftChange({
                    ...props.draft,
                    entryValue:
                      !value || value === unboundTargetValue ? null : value,
                  })
                }
              />
            )}
          </Group>
          <Group gap="xs">
            <SegmentedControl
              size="xs"
              value={view}
              onChange={(value) => setView(value as "canvas" | "form")}
              data={[
                { value: "canvas", label: "Canvas" },
                { value: "form", label: "Form" },
              ]}
            />
            <Button
              leftSection={<Save size={16} />}
              loading={props.busy}
              disabled={!props.draft.name.trim()}
              onClick={props.onSave}
            >
              Save
            </Button>
          </Group>
        </Group>

        {view === "canvas" && (
          <PipelineCanvas
            ctx={ctx}
            onDraftChange={props.onDraftChange}
            explainTrace={props.explainTrace}
            onOpenPipeline={props.onOpenPipeline}
            onAddNode={addNode}
          />
        )}

        {view === "form" && (
          <>
            {props.draft.nodes.map((node) => (
              <Paper key={node.id} withBorder p="sm" radius="sm">
                <Stack gap="xs">
                  <Group justify="space-between" wrap="nowrap">
                    <Group gap="xs" wrap="wrap">
                      <Badge variant="light">
                        {pipelineNodeTypeLabel(node.type)}
                      </Badge>
                      <Code>{node.id}</Code>
                      <TextInput
                        size="xs"
                        placeholder="Node name"
                        value={node.name}
                        onChange={(event) => {
                          const name = event.currentTarget.value;
                          ctx.updateNode(node.id, { name });
                        }}
                      />
                    </Group>
                    <Tooltip label="Delete node">
                      <ActionIcon
                        aria-label="Delete pipeline node"
                        variant="subtle"
                        color="red"
                        onClick={() =>
                          props.onDraftChange(
                            removeNodeFromDraft(props.draft, node.id),
                          )
                        }
                      >
                        <Trash2 size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                  <PipelineNodeFields node={node} ctx={ctx} />
                </Stack>
              </Paper>
            ))}

            <Group gap="xs" wrap="wrap">
              {pipelineNodeTypeOptions.map((option) => (
                <Button
                  key={option.value}
                  variant="light"
                  size="xs"
                  leftSection={<Plus size={14} />}
                  onClick={() => addNode(option.value)}
                >
                  {option.label}
                </Button>
              ))}
              <Menu position="bottom-start" withinPortal>
                <Menu.Target>
                  <Button
                    variant="light"
                    color="indigo"
                    size="xs"
                    leftSection={<Plus size={14} />}
                    disabled={otherPipelines.length === 0}
                  >
                    Pipeline
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  {otherPipelines.map((pipeline) => (
                    <Menu.Item
                      key={pipeline.id}
                      onClick={() =>
                        props.onDraftChange(
                          addPipelineNodeToDraft(props.draft, pipeline.id),
                        )
                      }
                    >
                      {pipeline.name}
                    </Menu.Item>
                  ))}
                </Menu.Dropdown>
              </Menu>
            </Group>
          </>
        )}
      </Stack>
    </Paper>
  );
}
