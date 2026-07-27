import {
  apiProxyPipelineNodePorts,
  type ApiProxyModelRecord,
  type ApiProxyPipelineRecord,
  type ApiProxyPortRef,
  type ApiProxyTargetRecord,
} from "@arriero/core";
import { Badge, Code, Group, Paper, Stack, Text } from "@mantine/core";
import { useMemo } from "react";

type TopologyProps = {
  models: ApiProxyModelRecord[];
  pipelines: ApiProxyPipelineRecord[];
  targets: ApiProxyTargetRecord[];
  onOpenPipeline: (pipelineId: string) => void;
};

type ModelChain = {
  model: ApiProxyModelRecord;
  firstHop: {
    kind: "target" | "pipeline" | "endpoint" | "unbound";
    id: string | null;
  };
  pipelineIds: string[];
  targetIds: string[];
  danglingRefs: string[];
};

function pipelineRefs(pipeline: ApiProxyPipelineRecord): ApiProxyPortRef[] {
  const refs: ApiProxyPortRef[] = [];
  if (pipeline.entry) {
    refs.push(pipeline.entry);
  }
  for (const node of pipeline.nodes) {
    refs.push(...apiProxyPipelineNodePorts(node).map((port) => port.ref));
    if (node.type === "call") {
      refs.push({ type: "pipeline", id: node.config.pipelineId });
    }
  }
  return refs;
}

function buildModelChain(
  model: ApiProxyModelRecord,
  pipelineById: Map<string, ApiProxyPipelineRecord>,
  targetById: Map<string, ApiProxyTargetRecord>,
): ModelChain {
  const routeTo =
    model.routeTo ??
    (model.targetId ? { type: "target" as const, id: model.targetId } : null);
  const pipelineIds: string[] = [];
  const targetIds = new Set<string>();
  const dangling = new Set<string>();
  const visited = new Set<string>();

  const visitRef = (ref: { type: string; id: string }) => {
    if (ref.type === "target") {
      if (targetById.has(ref.id)) {
        targetIds.add(ref.id);
      } else {
        dangling.add(`target ${ref.id}`);
      }
      return;
    }
    if (ref.type === "pipeline") {
      if (visited.has(ref.id)) {
        return;
      }
      visited.add(ref.id);
      const pipeline = pipelineById.get(ref.id);
      if (!pipeline) {
        dangling.add(`pipeline ${ref.id}`);
        return;
      }
      pipelineIds.push(pipeline.id);
      for (const next of pipelineRefs(pipeline)) {
        visitRef(next);
      }
    }
  };

  if (routeTo && routeTo.type !== "endpoint") {
    visitRef(routeTo);
  }

  return {
    model,
    firstHop: routeTo
      ? routeTo.type === "endpoint"
        ? { kind: "endpoint", id: routeTo.endpointId }
        : { kind: routeTo.type, id: routeTo.id }
      : { kind: "unbound", id: null },
    pipelineIds,
    targetIds: [...targetIds],
    danglingRefs: [...dangling],
  };
}

export function Topology(props: TopologyProps) {
  const pipelineById = useMemo(
    () => new Map(props.pipelines.map((pipeline) => [pipeline.id, pipeline])),
    [props.pipelines],
  );
  const targetById = useMemo(
    () => new Map(props.targets.map((target) => [target.id, target])),
    [props.targets],
  );

  const chains = useMemo(
    () =>
      props.models.map((model) =>
        buildModelChain(model, pipelineById, targetById),
      ),
    [props.models, pipelineById, targetById],
  );

  const unusedPipelines = useMemo(() => {
    const used = new Set(chains.flatMap((chain) => chain.pipelineIds));
    return props.pipelines.filter((pipeline) => !used.has(pipeline.id));
  }, [chains, props.pipelines]);

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Group justify="space-between" align="center" wrap="wrap">
          <Text fw={600}>Topology</Text>
          <Text c="dimmed" size="sm">
            What each published model can reach through its route.
          </Text>
        </Group>
        <Stack gap={6}>
          {chains.map((chain) => (
            <Group key={chain.model.id} gap="xs" wrap="wrap">
              <Code>{chain.model.modelId}</Code>
              <Text c="dimmed" size="sm">
                →
              </Text>
              {chain.firstHop.kind === "unbound" && (
                <Badge color="red" variant="light">
                  unbound
                </Badge>
              )}
              {chain.firstHop.kind === "endpoint" && (
                <Badge color="violet" variant="light">
                  external endpoint
                </Badge>
              )}
              {chain.pipelineIds.map((pipelineId) => (
                <Badge
                  key={pipelineId}
                  variant="outline"
                  style={{ cursor: "pointer", textTransform: "none" }}
                  onClick={() => props.onOpenPipeline(pipelineId)}
                >
                  {pipelineById.get(pipelineId)?.name ?? pipelineId}
                </Badge>
              ))}
              {chain.targetIds.length > 0 && (
                <>
                  <Text c="dimmed" size="sm">
                    ⇒
                  </Text>
                  {chain.targetIds.map((targetId) => (
                    <Badge
                      key={targetId}
                      color="teal"
                      variant="light"
                      style={{ textTransform: "none" }}
                    >
                      {targetById.get(targetId)?.name ?? targetId}
                    </Badge>
                  ))}
                </>
              )}
              {chain.danglingRefs.map((ref) => (
                <Badge key={ref} color="red" variant="light">
                  missing {ref}
                </Badge>
              ))}
            </Group>
          ))}
          {chains.length === 0 && (
            <Text c="dimmed" size="sm">
              No published models yet.
            </Text>
          )}
          {unusedPipelines.length > 0 && (
            <Group gap="xs" wrap="wrap">
              <Text c="dimmed" size="sm">
                Not reachable from any model:
              </Text>
              {unusedPipelines.map((pipeline) => (
                <Badge
                  key={pipeline.id}
                  color="gray"
                  variant="outline"
                  style={{ cursor: "pointer", textTransform: "none" }}
                  onClick={() => props.onOpenPipeline(pipeline.id)}
                >
                  {pipeline.name}
                </Badge>
              ))}
            </Group>
          )}
        </Stack>
      </Stack>
    </Paper>
  );
}
