import type {
  ApiProxyModelCreate,
  ApiProxyModelRecord,
  ApiProxyModelUpdate,
} from "@arriero/core";
import { Badge, Button, Group, Paper, Stack } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation } from "@tanstack/react-query";
import { Plus, PowerOff, Zap } from "lucide-react";
import { useState } from "react";

import {
  createApiProxyModel,
  createApiProxyPipeline,
  createApiProxyQuickRoute,
  deleteApiProxyModel,
  updateApiProxyModel,
} from "../../api/client";
import { useProxyConfig } from "../proxy/data";
import {
  emptyModelDraft,
  emptyQuickRouteDraft,
  modelDirectTargetId,
  modelDraftFromRecord,
  modelPayload,
  quickRoutePayload,
  unboundTargetValue,
  type ModelDraft,
  type ModelEditor,
  type QuickRouteDraft,
} from "../proxy/forms";
import { ModelEditorModal, QuickRouteModal } from "../proxy/editors";
import { ExternalModelsSection } from "../proxy/sections/index";
import { navigateProxy } from "../routing";
import { countLabel } from "../utils/plural";

function suggestPipelineName(modelId: string, taken: Set<string>): string {
  const base = modelId.slice(0, 72) || "route";
  if (!taken.has(base)) {
    return base;
  }
  let index = 2;
  while (taken.has(`${base} ${index}`)) {
    index += 1;
  }
  return `${base} ${index}`;
}

export function ProxyModelsView() {
  const { models, pipelines, targets, pipelineById, targetById, invalidate } =
    useProxyConfig();

  const [modelEditor, setModelEditor] = useState<ModelEditor | null>(null);
  const [modelDraft, setModelDraft] = useState<ModelDraft>(emptyModelDraft);
  const [quickRouteOpen, setQuickRouteOpen] = useState(false);
  const [quickRouteDraft, setQuickRouteDraft] =
    useState<QuickRouteDraft>(emptyQuickRouteDraft);

  const routeToOptions = [
    { value: unboundTargetValue, label: "Unbound" },
    ...pipelines.map((pipeline) => ({
      value: `pipeline:${pipeline.id}`,
      label: `Pipeline: ${pipeline.name}`,
    })),
    ...targets.map((target) => ({
      value: `target:${target.id}`,
      label: `Target: ${target.name}`,
    })),
  ];

  function closeModelEditor() {
    setModelEditor(null);
    setModelDraft(emptyModelDraft);
  }

  function closeQuickRoute() {
    setQuickRouteOpen(false);
    setQuickRouteDraft(emptyQuickRouteDraft);
  }

  const createModelMutation = useMutation({
    mutationFn: createApiProxyModel,
    onSuccess: async () => {
      await invalidate();
      closeModelEditor();
      notifications.show({
        title: "Proxy model saved",
        message: "External model entry was saved.",
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Proxy model save failed",
        message: (error as Error).message,
      }),
  });
  const updateModelMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ApiProxyModelCreate }) =>
      updateApiProxyModel(id, input),
    onSuccess: async () => {
      await invalidate();
      closeModelEditor();
      notifications.show({
        title: "Proxy model updated",
        message: "External model entry was saved.",
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Proxy model update failed",
        message: (error as Error).message,
      }),
  });
  const deleteModelMutation = useMutation({
    mutationFn: deleteApiProxyModel,
    onSuccess: async () => {
      await invalidate();
      notifications.show({
        title: "Proxy model deleted",
        message: "External model entry was removed.",
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Proxy model delete failed",
        message: (error as Error).message,
      }),
  });
  const toggleModelMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ApiProxyModelUpdate }) =>
      updateApiProxyModel(id, patch),
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Proxy model update failed",
        message: (error as Error).message,
      }),
  });
  const disableAllMutation = useMutation({
    mutationFn: async () => {
      const enabledModels = models.filter((model) => model.enabled);
      await Promise.all(
        enabledModels.map((model) =>
          updateApiProxyModel(model.id, { enabled: false }),
        ),
      );
      return enabledModels.length;
    },
    onSuccess: async (count) => {
      await invalidate();
      notifications.show({
        title: "Models disabled",
        message: `${countLabel(count, "model")} stopped serving.`,
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Disable all failed",
        message: (error as Error).message,
      }),
  });
  const quickRouteMutation = useMutation({
    mutationFn: createApiProxyQuickRoute,
    onSuccess: async (result) => {
      await invalidate();
      closeQuickRoute();
      notifications.show({
        title: "Quick route created",
        message: `Model ${result.data.model.modelId} now routes to target ${result.data.target.name}.`,
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Quick route failed",
        message: (error as Error).message,
      }),
  });
  const createPipelineForModelMutation = useMutation({
    mutationFn: async (model: ApiProxyModelRecord) => {
      const targetId = modelDirectTargetId(model);
      if (!targetId) {
        throw new Error("model is not routed directly to a target");
      }
      const taken = new Set(pipelines.map((pipeline) => pipeline.name));
      const created = await createApiProxyPipeline({
        name: suggestPipelineName(model.modelId, taken),
        enabled: true,
        entry: { type: "target", id: targetId },
        nodes: [],
      });
      await updateApiProxyModel(model.id, {
        routeTo: { type: "pipeline", id: created.data.id },
        targetId: null,
      });
      return created.data;
    },
    onSuccess: async (pipeline) => {
      await invalidate();
      navigateProxy(`pipelines/${pipeline.id}`);
      notifications.show({
        title: "Pipeline created",
        message: `Pipeline "${pipeline.name}" was inserted between the model and its target.`,
      });
    },
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "Pipeline insert failed",
        message: (error as Error).message,
      }),
  });

  function saveModel() {
    const input = modelPayload(modelDraft);
    if (modelEditor?.mode === "edit") {
      updateModelMutation.mutate({ id: modelEditor.model.id, input });
      return;
    }
    createModelMutation.mutate(input);
  }

  const modelBusy =
    createModelMutation.isPending || updateModelMutation.isPending;
  const togglePendingId = toggleModelMutation.isPending
    ? (toggleModelMutation.variables?.id ?? null)
    : null;
  const enabledCount = models.filter((model) => model.enabled).length;

  return (
    <Stack gap="md">
      <Paper withBorder p="md" radius="sm">
        <Group justify="space-between" align="center" wrap="wrap">
          <Group gap="xs">
            <Badge variant="light">{countLabel(models.length, "model")}</Badge>
            <Badge variant="light" color="green">
              {enabledCount} enabled
            </Badge>
          </Group>
          <Group gap="xs" wrap="wrap">
            <Button
              variant="default"
              leftSection={<PowerOff size={16} />}
              disabled={enabledCount === 0}
              loading={disableAllMutation.isPending}
              onClick={() => {
                if (
                  !window.confirm(
                    `Disable all ${countLabel(enabledCount, "serving model")}? They will respond model_disabled until re-enabled.`,
                  )
                ) {
                  return;
                }
                disableAllMutation.mutate();
              }}
            >
              Disable all
            </Button>
            <Button
              leftSection={<Zap size={16} />}
              onClick={() => {
                setQuickRouteDraft(emptyQuickRouteDraft);
                setQuickRouteOpen(true);
              }}
            >
              Quick route
            </Button>
            <Button
              variant="light"
              leftSection={<Plus size={16} />}
              onClick={() => {
                setModelEditor({ mode: "create", model: null });
                setModelDraft(emptyModelDraft);
              }}
            >
              Add model
            </Button>
          </Group>
        </Group>
      </Paper>

      <ExternalModelsSection
        models={models}
        pipelineById={pipelineById}
        targetById={targetById}
        deletePending={deleteModelMutation.isPending}
        createPipelinePending={createPipelineForModelMutation.isPending}
        togglePendingId={togglePendingId}
        onEdit={(model) => {
          setModelEditor({ mode: "edit", model });
          setModelDraft(modelDraftFromRecord(model));
        }}
        onDelete={(id) => deleteModelMutation.mutate(id)}
        onOpenPipeline={(id) => navigateProxy(`pipelines/${id}`)}
        onCreatePipeline={(model) =>
          createPipelineForModelMutation.mutate(model)
        }
        onSetVisible={(model, visible) =>
          toggleModelMutation.mutate({ id: model.id, patch: { visible } })
        }
        onSetEnabled={(model, enabled) =>
          toggleModelMutation.mutate({ id: model.id, patch: { enabled } })
        }
      />

      <ModelEditorModal
        editor={modelEditor}
        draft={modelDraft}
        routeToOptions={routeToOptions}
        busy={modelBusy}
        onClose={closeModelEditor}
        onSave={saveModel}
        onDraftChange={setModelDraft}
      />

      <QuickRouteModal
        opened={quickRouteOpen}
        draft={quickRouteDraft}
        busy={quickRouteMutation.isPending}
        onClose={closeQuickRoute}
        onCreate={() =>
          quickRouteMutation.mutate(quickRoutePayload(quickRouteDraft))
        }
        onDraftChange={setQuickRouteDraft}
      />
    </Stack>
  );
}
