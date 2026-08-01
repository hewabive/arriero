import type {
  ApiProxyPipelineCreate,
  ApiProxyRouteExplainResult,
} from "@arriero/core";
import {
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";

import {
  createApiProxyPipeline,
  deleteApiProxyPipeline,
  listApiProxySources,
  updateApiProxyModel,
  updateApiProxyPipeline,
} from "../../api/client";
import { useProxyConfig } from "../proxy/data";
import {
  emptyPipelineDraft,
  pipelineDraftFromRecord,
  pipelinePayload,
  type PipelineDraft,
} from "../proxy/forms";
import { PipelinePanel } from "../proxy/PipelinePanel";
import { PipelinesSection } from "../proxy/sections/index";
import { TestBench } from "../proxy/TestBench";
import { countLabel } from "../utils/plural";

const newPipelineSubpath = "new";

type ProxyPipelinesViewProps = {
  subpath: string;
  setSubpath: (next: string) => void;
};

export function ProxyPipelinesView({
  subpath,
  setSubpath,
}: ProxyPipelinesViewProps) {
  const {
    proxyQuery,
    models,
    pipelines,
    targets,
    pipelineById,
    targetById,
    proxyUsage,
    invalidate,
  } = useProxyConfig();
  const sourcesQuery = useQuery({
    queryKey: ["api-proxy-sources"],
    queryFn: listApiProxySources,
    staleTime: 10_000,
  });
  const sources = sourcesQuery.data?.data ?? [];

  const [pipelineDraft, setPipelineDraft] =
    useState<PipelineDraft>(emptyPipelineDraft);
  const [pipelineDraftFor, setPipelineDraftFor] = useState<string | null>(null);
  const [pipelineStack, setPipelineStack] = useState<
    Array<{ pipelineId: string; draft: PipelineDraft }>
  >([]);
  const [explainResult, setExplainResult] =
    useState<ApiProxyRouteExplainResult | null>(null);

  const createPipelineMutation = useMutation({
    mutationFn: createApiProxyPipeline,
    onSuccess: async (result) => {
      await invalidate();
      setPipelineDraftFor(result.data.id);
      setSubpath(result.data.id);
      notifications.show({
        title: "Pipeline saved",
        message: "Pipeline was created.",
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Pipeline save failed",
        message: (error as Error).message,
      }),
  });
  const updatePipelineMutation = useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: ApiProxyPipelineCreate;
    }) => updateApiProxyPipeline(id, input),
    onSuccess: async () => {
      await invalidate();
      notifications.show({
        title: "Pipeline updated",
        message: "Pipeline configuration was saved.",
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Pipeline update failed",
        message: (error as Error).message,
      }),
  });
  const deletePipelineMutation = useMutation({
    mutationFn: deleteApiProxyPipeline,
    onSuccess: async () => {
      await invalidate();
      notifications.show({
        title: "Pipeline deleted",
        message: "Pipeline was removed.",
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Pipeline delete failed",
        message: (error as Error).message,
      }),
  });

  async function applyStagedModelBindings(pipelineId: string) {
    const bind = pipelineDraft.bindModelIds;
    const unbind = pipelineDraft.unbindModelIds;
    if (bind.length === 0 && unbind.length === 0) {
      return;
    }
    try {
      for (const id of unbind) {
        await updateApiProxyModel(id, { routeTo: null, targetId: null });
      }
      for (const id of bind) {
        await updateApiProxyModel(id, {
          routeTo: { type: "pipeline", id: pipelineId },
          targetId: null,
        });
      }
      setPipelineDraft((prev) => ({
        ...prev,
        bindModelIds: [],
        unbindModelIds: [],
      }));
      notifications.show({
        title: "Routed models updated",
        message: "Model bindings were saved.",
      });
    } catch (error) {
      notifications.show({
        color: "red",
        title: "Model binding failed",
        message: (error as Error).message,
      });
    } finally {
      await invalidate();
    }
  }

  async function savePipeline() {
    const input = pipelinePayload(pipelineDraft);
    let pipelineId: string;
    try {
      if (subpath && subpath !== newPipelineSubpath) {
        await updatePipelineMutation.mutateAsync({ id: subpath, input });
        pipelineId = subpath;
      } else {
        const result = await createPipelineMutation.mutateAsync(input);
        pipelineId = result.data.id;
      }
    } catch {
      return;
    }
    await applyStagedModelBindings(pipelineId);
  }

  function openPipeline(pipelineId: string) {
    setPipelineStack([]);
    setSubpath(pipelineId);
  }

  function enterNestedPipeline(pipelineId: string) {
    if (subpath && subpath !== pipelineId) {
      setPipelineStack((prev) => [
        ...prev,
        { pipelineId: subpath, draft: pipelineDraft },
      ]);
    }
    setSubpath(pipelineId);
  }

  function backFromPipeline() {
    const parent = pipelineStack[pipelineStack.length - 1];
    if (!parent) {
      setSubpath("");
      return;
    }
    setPipelineStack((prev) => prev.slice(0, -1));
    setPipelineDraftFor(parent.pipelineId);
    setPipelineDraft(parent.draft);
    setSubpath(parent.pipelineId);
  }

  const parentEntry = pipelineStack[pipelineStack.length - 1];
  const backLabel = parentEntry
    ? `Back to ${
        pipelineById.get(parentEntry.pipelineId)?.name ||
        parentEntry.draft.name ||
        "pipeline"
      }`
    : "Back";

  const editorPipeline =
    subpath && subpath !== newPipelineSubpath
      ? (pipelineById.get(subpath) ?? null)
      : null;

  if (subpath && pipelineDraftFor !== subpath) {
    if (subpath === newPipelineSubpath) {
      setPipelineDraftFor(subpath);
      setPipelineDraft(emptyPipelineDraft);
    } else if (editorPipeline) {
      setPipelineDraftFor(subpath);
      setPipelineDraft(pipelineDraftFromRecord(editorPipeline));
    }
  }

  const pipelineBusy =
    createPipelineMutation.isPending || updatePipelineMutation.isPending;
  const editorOpen = Boolean(subpath);
  const editorReady = subpath === newPipelineSubpath || Boolean(editorPipeline);

  return (
    <Stack gap="md">
      {!editorOpen && (
        <>
          <Paper withBorder p="md" radius="sm">
            <Group justify="space-between" align="center" wrap="wrap">
              <Badge variant="light">
                {countLabel(pipelines.length, "pipeline")}
              </Badge>
              <Button
                variant="light"
                leftSection={<Plus size={16} />}
                onClick={() => openPipeline(newPipelineSubpath)}
              >
                Add pipeline
              </Button>
            </Group>
          </Paper>

          <PipelinesSection
            pipelines={pipelines}
            pipelineById={pipelineById}
            targetById={targetById}
            usageByPipelineId={proxyUsage.byPipelineId}
            deletePending={deletePipelineMutation.isPending}
            onEdit={(pipeline) => openPipeline(pipeline.id)}
            onDelete={(id) => deletePipelineMutation.mutate(id)}
          />
        </>
      )}

      {editorOpen && editorReady && (
        <PipelinePanel
          mode={subpath === newPipelineSubpath ? "create" : "edit"}
          pipelineId={subpath === newPipelineSubpath ? null : subpath}
          draft={pipelineDraft}
          targets={targets}
          pipelines={pipelines}
          sources={sources}
          models={models}
          busy={pipelineBusy}
          explainTrace={explainResult?.routeTrace ?? null}
          backLabel={backLabel}
          onBack={backFromPipeline}
          onSave={savePipeline}
          onDraftChange={setPipelineDraft}
          onOpenPipeline={enterNestedPipeline}
        />
      )}

      {editorOpen && !editorReady && (
        <Stack align="center" py="xl">
          {proxyQuery.isLoading ? (
            <Loader />
          ) : (
            <Text c="dimmed">Pipeline {subpath} not found.</Text>
          )}
        </Stack>
      )}

      <TestBench
        models={models}
        sources={sources}
        onResult={setExplainResult}
      />
    </Stack>
  );
}
