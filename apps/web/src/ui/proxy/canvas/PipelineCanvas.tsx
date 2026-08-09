import {
  assertNever,
  collectApiProxyRouteHoles,
  type ApiProxyRouteTraceStep,
} from "@arriero/core";
import {
  ActionIcon,
  Badge,
  Button,
  Code,
  Flex,
  Group,
  Menu,
  Paper,
  Stack,
  Text,
  TextInput,
  useComputedColorScheme,
} from "@mantine/core";
import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Plus, Trash2, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  buildFlowGraph,
  collectPipelineReferrers,
  columnWidth,
  entryNodeId,
  highlightFromTrace,
  portValueFromFlowId,
  refNodeId,
  referrerFlowPrefix,
  referrerPipelineFlowPrefix,
  type FlowNode,
} from "./canvas-model";
import { FlowEdge } from "./FlowEdge";
import { FlowNodeCard } from "./FlowNodeCard";
import type {
  PipelineDraft,
  PipelineNodeDraft,
  PipelineNodeDraftOf,
  PipelineNodeDraftPatch,
  PortValue,
} from "../forms";
import {
  addPipelineNodeToDraft,
  isSingleNextPipelineNodeDraft,
  pipelinePayload,
  removeNodeFromDraft,
} from "../forms";
import {
  PipelineNodeFields,
  PortSelect,
  editorCallExitNames,
  pipelineNodeTypeLabel,
  pipelineNodeTypeOptions,
  type PipelineEditorContext,
} from "../node-fields/index";
import { TouchSelect } from "../../components/TouchCombobox";
import { useNarrowScreen } from "../../hooks/use-narrow-screen";

const nodeTypes = { "pipeline-flow": FlowNodeCard };
const edgeTypes = { "pipeline-edge": FlowEdge };
const draftCandidateId = "__draft__";

function portPatch(
  node: PipelineNodeDraft,
  port: string,
  value: PortValue,
): PipelineNodeDraftPatch | null {
  if (isSingleNextPipelineNodeDraft(node)) {
    return port === "next" ? { portNext: value } : null;
  }
  switch (node.type) {
    case "condition":
      if (port === "true") {
        return { portTrue: value };
      }
      if (port === "false") {
        return { portFalse: value };
      }
      return null;
    case "call":
      return { callPorts: { ...node.callPorts, [port]: value } };
    case "exit":
      return null;
    case "fusion": {
      if (port === "synthesizer") {
        return { fusionSynthesizer: value };
      }
      const match = /^panel-(\d+)$/.exec(port);
      if (!match) {
        return null;
      }
      const index = Number(match[1]);
      return {
        fusionPanel: node.fusionPanel.map((current, i) =>
          i === index ? value : current,
        ),
      };
    }
    default:
      return assertNever(node);
  }
}

export type PipelineCanvasProps = {
  ctx: PipelineEditorContext;
  onDraftChange: (draft: PipelineDraft) => void;
  explainTrace: ApiProxyRouteTraceStep[] | null;
  onOpenPipeline: (pipelineId: string) => void;
  onAddNode: (type: PipelineNodeDraft["type"]) => void;
};

export function PipelineCanvas(props: PipelineCanvasProps) {
  const colorScheme = useComputedColorScheme("dark");
  const isNarrow = useNarrowScreen();
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [placedRefs, setPlacedRefs] = useState<string[]>([]);
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const inspectorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (isNarrow && selectedNodeId !== null) {
      inspectorRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [isNarrow, selectedNodeId]);

  useEffect(() => {
    positionsRef.current.clear();
    setPlacedRefs([]);
    setSelectedNodeId(null);
  }, [props.ctx.pipelineId]);

  const draft = props.ctx.draft;
  const highlight = useMemo(
    () => highlightFromTrace(props.explainTrace, props.ctx.pipelineId),
    [props.explainTrace, props.ctx.pipelineId],
  );
  const exitNamesByNodeId = useMemo(
    () =>
      new Map(
        draft.nodes
          .filter(
            (node): node is PipelineNodeDraftOf<"call"> => node.type === "call",
          )
          .map(
            (node) => [node.id, editorCallExitNames(props.ctx, node)] as const,
          ),
      ),
    [draft.nodes, props.ctx],
  );

  const boundModels = useMemo(() => {
    const saved = props.ctx.models
      .filter(
        (model) =>
          props.ctx.pipelineId !== null &&
          model.routeTo?.type === "pipeline" &&
          model.routeTo.id === props.ctx.pipelineId &&
          !draft.unbindModelIds.includes(model.id),
      )
      .map((model) => ({ model, staged: false }));
    const stagedModels = draft.bindModelIds.flatMap((id) => {
      const model = props.ctx.models.find((item) => item.id === id);
      return model ? [{ model, staged: true }] : [];
    });
    return [...saved, ...stagedModels];
  }, [
    props.ctx.models,
    props.ctx.pipelineId,
    draft.bindModelIds,
    draft.unbindModelIds,
  ]);

  const referrers = useMemo(
    () =>
      collectPipelineReferrers({
        pipelineId: props.ctx.pipelineId,
        models: props.ctx.models,
        pipelines: props.ctx.pipelines,
        bindModelIds: draft.bindModelIds,
        unbindModelIds: draft.unbindModelIds,
      }),
    [
      props.ctx.pipelineId,
      props.ctx.models,
      props.ctx.pipelines,
      draft.bindModelIds,
      draft.unbindModelIds,
    ],
  );

  const candidateGraph = useMemo(() => {
    const payload = pipelinePayload(draft);
    return {
      id: props.ctx.pipelineId ?? draftCandidateId,
      name: payload.name || "this pipeline",
      entry: payload.entry,
      nodes: payload.nodes,
    };
  }, [draft, props.ctx.pipelineId]);

  const routeHoles = useMemo(() => {
    if (boundModels.length === 0) {
      return [];
    }
    return collectApiProxyRouteHoles(candidateGraph.id, (id) =>
      id === candidateGraph.id
        ? candidateGraph
        : (props.ctx.pipelines.find((pipeline) => pipeline.id === id) ?? null),
    );
  }, [boundModels.length, candidateGraph, props.ctx.pipelines]);

  const invalidNodeIds = useMemo(
    () =>
      new Set(
        routeHoles.flatMap((hole) =>
          hole.pipelineId === candidateGraph.id && hole.nodeId
            ? [hole.nodeId]
            : [],
        ),
      ),
    [routeHoles, candidateGraph.id],
  );

  useEffect(() => {
    const graph = buildFlowGraph({
      draft,
      targets: props.ctx.targets,
      pipelines: props.ctx.pipelines,
      sources: props.ctx.sources,
      exitNamesByNodeId,
      highlight,
      previousPositions: positionsRef.current,
      selectedNodeId,
      referrers,
      entryInvalid: routeHoles.length > 0,
      invalidNodeIds,
      placedRefs,
    });
    setRfNodes(graph.nodes);
    setRfEdges(graph.edges);
    for (const node of graph.nodes) {
      positionsRef.current.set(node.id, node.position);
    }
  }, [
    draft,
    exitNamesByNodeId,
    highlight,
    selectedNodeId,
    referrers,
    routeHoles,
    invalidNodeIds,
    placedRefs,
    props.ctx.targets,
    props.ctx.pipelines,
    props.ctx.sources,
    setRfEdges,
    setRfNodes,
  ]);

  const handleNodesChange = (changes: NodeChange<FlowNode>[]) => {
    onNodesChange(changes);
    for (const change of changes) {
      if (change.type === "position" && change.position) {
        positionsRef.current.set(change.id, change.position);
      }
    }
  };

  const handleConnect = (connection: Connection) => {
    if (!connection.source || !connection.target) {
      return;
    }
    if (connection.source === connection.target) {
      return;
    }
    if (
      connection.target === entryNodeId ||
      connection.target.startsWith(referrerFlowPrefix) ||
      connection.source.startsWith(referrerFlowPrefix)
    ) {
      return;
    }
    const value = portValueFromFlowId(connection.target);
    if (connection.source === entryNodeId) {
      props.onDraftChange({ ...draft, entryValue: value });
      return;
    }
    const node = draft.nodes.find((item) => item.id === connection.source);
    if (!node || !connection.sourceHandle) {
      return;
    }
    const patch = portPatch(node, connection.sourceHandle, value);
    if (patch) {
      props.ctx.updateNode(node.id, patch);
    }
  };

  const handleDelete = (deleted: { nodes: Node[]; edges: Edge[] }) => {
    const deletedNodeIds = new Set(deleted.nodes.map((node) => node.id));
    let next = draft;
    for (const edge of deleted.edges) {
      if (edge.source === entryNodeId) {
        next = { ...next, entryValue: null };
        continue;
      }
      const node = next.nodes.find((item) => item.id === edge.source);
      if (!node || !edge.sourceHandle) {
        continue;
      }
      const patch = portPatch(node, edge.sourceHandle, null);
      if (patch) {
        next = {
          ...next,
          nodes: next.nodes.map((item) =>
            item.id === node.id ? { ...item, ...patch } : item,
          ),
        };
      }
    }
    for (const node of deleted.nodes) {
      if (next.nodes.some((item) => item.id === node.id)) {
        next = removeNodeFromDraft(next, node.id);
      }
    }
    if (next !== draft) {
      props.onDraftChange(next);
    }
    if (selectedNodeId && deletedNodeIds.has(selectedNodeId)) {
      setSelectedNodeId(null);
    }
    setPlacedRefs((prev) => {
      let result = prev;
      for (const edge of deleted.edges) {
        if (
          !edge.target.startsWith("ref:") ||
          deletedNodeIds.has(edge.target)
        ) {
          continue;
        }
        const value = portValueFromFlowId(edge.target);
        if (value && !result.includes(value)) {
          result = [...result, value];
        }
      }
      const removedValues = new Set(
        deleted.nodes
          .filter((node) => node.id.startsWith("ref:"))
          .map((node) => portValueFromFlowId(node.id)),
      );
      if (removedValues.size > 0) {
        result = result.filter((value) => !removedValues.has(value));
      }
      return result;
    });
  };

  const placeRef = (value: string) => {
    const flowId = refNodeId(value);
    if (!positionsRef.current.has(flowId)) {
      const xs = [...positionsRef.current.values()].map(
        (position) => position.x,
      );
      positionsRef.current.set(flowId, {
        x: (xs.length > 0 ? Math.max(...xs) : 0) + columnWidth,
        y: 60 + placedRefs.length * 110,
      });
    }
    setPlacedRefs((prev) => (prev.includes(value) ? prev : [...prev, value]));
  };

  const placeTarget = (targetId: string) => placeRef(`target:${targetId}`);

  const addPipelineNode = (pipelineId: string) =>
    props.onDraftChange(addPipelineNodeToDraft(draft, pipelineId));

  const otherPipelines = props.ctx.pipelines.filter(
    (pipeline) => pipeline.id !== props.ctx.pipelineId,
  );

  const handleNodeDragStop = (_event: unknown, node: Node) => {
    if (draft.nodes.some((item) => item.id === node.id)) {
      props.ctx.updateNode(node.id, {
        layout: { x: node.position.x, y: node.position.y },
      });
    }
  };

  const handleNodeDoubleClick = (_event: unknown, node: Node) => {
    if (node.id.startsWith("ref:pipeline:")) {
      props.onOpenPipeline(node.id.slice("ref:pipeline:".length));
      return;
    }
    if (node.id.startsWith(referrerPipelineFlowPrefix)) {
      props.onOpenPipeline(node.id.slice(referrerPipelineFlowPrefix.length));
      return;
    }
    const draftNode = draft.nodes.find((item) => item.id === node.id);
    if (draftNode?.type === "call" && draftNode.callPipelineId) {
      props.onOpenPipeline(draftNode.callPipelineId);
    }
  };

  const handleNodeClick = (_event: unknown, node: Node) => {
    if (node.id === entryNodeId || node.id.startsWith(referrerFlowPrefix)) {
      setSelectedNodeId(entryNodeId);
      return;
    }
    if (node.id.startsWith("ref:")) {
      setSelectedNodeId(node.id);
      return;
    }
    setSelectedNodeId(
      draft.nodes.some((item) => item.id === node.id) ? node.id : null,
    );
  };

  const attachModel = (modelId: string | null) => {
    if (!modelId) {
      return;
    }
    if (draft.unbindModelIds.includes(modelId)) {
      props.onDraftChange({
        ...draft,
        unbindModelIds: draft.unbindModelIds.filter((id) => id !== modelId),
      });
      return;
    }
    if (!draft.bindModelIds.includes(modelId)) {
      props.onDraftChange({
        ...draft,
        bindModelIds: [...draft.bindModelIds, modelId],
      });
    }
  };

  const detachModel = (modelId: string) => {
    if (draft.bindModelIds.includes(modelId)) {
      props.onDraftChange({
        ...draft,
        bindModelIds: draft.bindModelIds.filter((id) => id !== modelId),
      });
      return;
    }
    if (!draft.unbindModelIds.includes(modelId)) {
      props.onDraftChange({
        ...draft,
        unbindModelIds: [...draft.unbindModelIds, modelId],
      });
    }
  };

  const freeModelOptions = useMemo(
    () =>
      props.ctx.models
        .filter(
          (model) =>
            !model.routeTo &&
            !model.targetId &&
            !draft.bindModelIds.includes(model.id),
        )
        .map((model) => ({ value: model.id, label: model.modelId })),
    [props.ctx.models, draft.bindModelIds],
  );

  const stagedDetachedModels = useMemo(
    () =>
      draft.unbindModelIds.flatMap((id) => {
        const model = props.ctx.models.find((item) => item.id === id);
        return model ? [model] : [];
      }),
    [draft.unbindModelIds, props.ctx.models],
  );

  const pipelineReferrers = referrers.filter(
    (referrer) => referrer.kind === "ref-pipeline",
  );

  const selectedNode =
    draft.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const entrySelected = selectedNodeId === entryNodeId;

  return (
    <Stack gap="xs">
      <Group gap="xs" wrap="wrap">
        {pipelineNodeTypeOptions.map((option) => (
          <Button
            key={option.value}
            variant="light"
            size="xs"
            leftSection={<Plus size={14} />}
            onClick={() => props.onAddNode(option.value)}
          >
            {option.label}
          </Button>
        ))}
        <Menu position="bottom-start" withinPortal>
          <Menu.Target>
            <Button
              variant="light"
              color="teal"
              size="xs"
              leftSection={<Plus size={14} />}
              disabled={props.ctx.targets.length === 0}
            >
              Target
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {props.ctx.targets.map((target) => (
              <Menu.Item key={target.id} onClick={() => placeTarget(target.id)}>
                {target.name}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
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
                onClick={() => addPipelineNode(pipeline.id)}
              >
                {pipeline.name}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      </Group>
      <Flex direction={isNarrow ? "column" : "row"} align="stretch" gap="sm">
        <Paper
          withBorder
          radius="sm"
          style={
            isNarrow
              ? { height: "45vh", overflow: "hidden" }
              : { flex: 1, height: "62vh", minWidth: 0, overflow: "hidden" }
          }
        >
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            colorMode={colorScheme}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            connectionRadius={32}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={["Delete", "Backspace"]}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={handleConnect}
            onDelete={handleDelete}
            onNodeDragStop={handleNodeDragStop}
            onNodeClick={handleNodeClick}
            onNodeDoubleClick={handleNodeDoubleClick}
            onPaneClick={() => setSelectedNodeId(null)}
          >
            <Background gap={20} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </Paper>
        <Paper
          ref={inspectorRef}
          withBorder
          radius="sm"
          p="sm"
          style={
            isNarrow
              ? { maxHeight: "60vh", overflow: "auto" }
              : {
                  width: 340,
                  flexShrink: 0,
                  height: "62vh",
                  overflow: "auto",
                }
          }
        >
          {entrySelected ? (
            <Stack gap="xs">
              <Group gap="xs">
                <Badge variant="light" color="green">
                  Entry
                </Badge>
              </Group>
              <PortSelect
                label="Routes to"
                ctx={props.ctx}
                excludeNodeId={null}
                value={draft.entryValue}
                includePipelines
                onChange={(entryValue) =>
                  props.onDraftChange({ ...draft, entryValue })
                }
              />
              <Text fw={600} size="sm">
                Routed models
              </Text>
              {boundModels.length === 0 &&
                stagedDetachedModels.length === 0 && (
                  <Text c="dimmed" size="sm">
                    No models route into this pipeline. Attach an unbound model
                    to serve it directly.
                  </Text>
                )}
              {boundModels.map(({ model, staged }) => (
                <Group key={model.id} justify="space-between" wrap="nowrap">
                  <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                    <Text size="sm" truncate>
                      {model.modelId}
                    </Text>
                    {staged && (
                      <Badge size="xs" variant="light" color="yellow">
                        unsaved
                      </Badge>
                    )}
                  </Group>
                  <ActionIcon
                    aria-label="Detach model"
                    variant="subtle"
                    color="red"
                    size="sm"
                    onClick={() => detachModel(model.id)}
                  >
                    <Trash2 size={14} />
                  </ActionIcon>
                </Group>
              ))}
              {stagedDetachedModels.map((model) => (
                <Group key={model.id} justify="space-between" wrap="nowrap">
                  <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                    <Text size="sm" c="dimmed" td="line-through" truncate>
                      {model.modelId}
                    </Text>
                    <Badge size="xs" variant="light" color="yellow">
                      detached · unsaved
                    </Badge>
                  </Group>
                  <ActionIcon
                    aria-label="Undo detach"
                    variant="subtle"
                    size="sm"
                    onClick={() => attachModel(model.id)}
                  >
                    <Undo2 size={14} />
                  </ActionIcon>
                </Group>
              ))}
              <TouchSelect
                placeholder="Attach a model"
                data={freeModelOptions}
                value={null}
                searchable
                onChange={(value) => attachModel(value)}
              />
              <Text fw={600} size="sm">
                Referenced by
              </Text>
              {pipelineReferrers.length === 0 ? (
                <Text c="dimmed" size="sm">
                  Not called or jumped to by other pipelines.
                </Text>
              ) : (
                pipelineReferrers.map((referrer) => (
                  <Text size="sm" key={referrer.flowId}>
                    {referrer.title}{" "}
                    <Text span c="dimmed" size="sm">
                      — {referrer.summary}
                    </Text>
                  </Text>
                ))
              )}
              {boundModels.length > 0 &&
                (routeHoles.length > 0 ? (
                  <>
                    <Text fw={600} size="sm" c="red">
                      Route holes
                    </Text>
                    {routeHoles.map((hole) => (
                      <Text
                        size="xs"
                        c="red"
                        key={`${hole.pipelineId}:${hole.nodeId}:${hole.message}`}
                      >
                        {hole.message}
                      </Text>
                    ))}
                    <Text c="dimmed" size="xs">
                      A pipeline that serves a model must route every path to a
                      target. Saving is blocked until the holes are wired.
                    </Text>
                  </>
                ) : (
                  <Text size="sm" c="teal">
                    Route complete — every path ends at a target.
                  </Text>
                ))}
            </Stack>
          ) : selectedNode ? (
            <Stack gap="xs">
              <Group justify="space-between" wrap="nowrap">
                <Group gap="xs" wrap="wrap">
                  <Badge variant="light">
                    {pipelineNodeTypeLabel(selectedNode.type)}
                  </Badge>
                  <Code>{selectedNode.id}</Code>
                </Group>
                <Button
                  variant="subtle"
                  color="red"
                  size="xs"
                  leftSection={<Trash2 size={14} />}
                  onClick={() => {
                    props.onDraftChange(
                      removeNodeFromDraft(draft, selectedNode.id),
                    );
                    setSelectedNodeId(null);
                  }}
                >
                  Delete
                </Button>
              </Group>
              <TextInput
                size="xs"
                placeholder="Node name"
                value={selectedNode.name}
                onChange={(event) => {
                  const name = event.currentTarget.value;
                  props.ctx.updateNode(selectedNode.id, { name });
                }}
              />
              <PipelineNodeFields node={selectedNode} ctx={props.ctx} />
            </Stack>
          ) : (
            <Stack gap="xs">
              <Text fw={600} size="sm">
                Inspector
              </Text>
              <Text c="dimmed" size="sm">
                Select a node to edit its configuration. Click the entry node to
                manage which models route into this pipeline. Drag from a port
                to wire it to another node or a target. Double-click a pipeline
                node to open the nested pipeline.
              </Text>
            </Stack>
          )}
        </Paper>
      </Flex>
    </Stack>
  );
}
