import {
  engineDescriptor,
  type ApiProxyTargetCreate,
  type ApiProxyTargetRecord,
} from "@arriero/core";
import { Badge, Button, Group, Paper, Stack } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";

import {
  createApiProxyTarget,
  deleteApiProxyTarget,
  getApiProxyRuntime,
  listInstances,
  updateApiProxyTarget,
} from "../../api/client";
import { useProxyConfig } from "../proxy/data";
import {
  emptyTargetDraft,
  targetDraftFromRecord,
  targetPayload,
  type TargetDraft,
  type TargetEditor,
} from "../proxy/forms";
import { TargetEditorModal } from "../proxy/editors";
import { ProxyTargetsSection } from "../proxy/sections/index";
import { countLabel } from "../utils/plural";
import { notifyError } from "../utils/notify";

export function ProxyTargetsView() {
  const { targets, endpointById, proxyUsage, invalidate } = useProxyConfig();
  const instancesQuery = useQuery({
    queryKey: ["instances"],
    queryFn: listInstances,
    staleTime: 10_000,
  });
  const runtimeQuery = useQuery({
    queryKey: ["api-proxy-runtime"],
    queryFn: getApiProxyRuntime,
    refetchInterval: 5_000,
  });

  const [targetEditor, setTargetEditor] = useState<TargetEditor | null>(null);
  const [targetDraft, setTargetDraft] = useState<TargetDraft>(emptyTargetDraft);

  const instanceOptions = useMemo(
    () =>
      (instancesQuery.data?.data ?? []).map((instance) => ({
        value: instance.name,
        label: instance.name,
      })),
    [instancesQuery.data?.data],
  );
  const slotSaveAvailable = useMemo(() => {
    const endpoint = targetDraft.endpointId
      ? endpointById.get(targetDraft.endpointId)
      : undefined;
    const instance = endpoint?.instanceId
      ? (instancesQuery.data?.data ?? []).find(
          (item) => item.name === endpoint.instanceId,
        )
      : undefined;
    return instance ? engineDescriptor(instance.kind).proxy.slotSave : false;
  }, [targetDraft.endpointId, endpointById, instancesQuery.data?.data]);
  const runtimeByTargetId = useMemo(
    () =>
      new Map(
        (runtimeQuery.data?.data.targets ?? []).map((runtime) => [
          runtime.targetId,
          runtime,
        ]),
      ),
    [runtimeQuery.data?.data.targets],
  );

  function closeTargetEditor() {
    setTargetEditor(null);
    setTargetDraft(emptyTargetDraft);
  }

  const createTargetMutation = useMutation({
    mutationFn: createApiProxyTarget,
    onSuccess: async () => {
      await invalidate();
      closeTargetEditor();
      notifications.show({
        title: "Proxy target saved",
        message: "Target is ready to receive routed requests.",
      });
    },
    onError: notifyError("Proxy target save failed"),
  });
  const updateTargetMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ApiProxyTargetCreate }) =>
      updateApiProxyTarget(id, input),
    onSuccess: async () => {
      await invalidate();
      closeTargetEditor();
      notifications.show({
        title: "Proxy target updated",
        message: "Configuration was saved.",
      });
    },
    onError: notifyError("Proxy target update failed"),
  });
  const deleteTargetMutation = useMutation({
    mutationFn: deleteApiProxyTarget,
    onSuccess: async () => {
      await invalidate();
      notifications.show({
        title: "Proxy target deleted",
        message: "Configuration was removed.",
      });
    },
    onError: notifyError("Proxy target delete failed"),
  });

  function saveTarget() {
    const input = targetPayload(targetDraft);
    if (targetEditor?.mode === "edit") {
      updateTargetMutation.mutate({ id: targetEditor.target.id, input });
      return;
    }
    createTargetMutation.mutate(input);
  }

  const targetBusy =
    createTargetMutation.isPending || updateTargetMutation.isPending;

  return (
    <Stack gap="md">
      <Paper withBorder p="md" radius="sm">
        <Group justify="space-between" align="center" wrap="wrap">
          <Badge variant="light">{countLabel(targets.length, "target")}</Badge>
          <Button
            variant="light"
            leftSection={<Plus size={16} />}
            onClick={() => {
              setTargetEditor({ mode: "create", target: null });
              setTargetDraft(emptyTargetDraft);
            }}
          >
            Add target
          </Button>
        </Group>
      </Paper>

      <ProxyTargetsSection
        targets={targets}
        endpointById={endpointById}
        usageByTargetId={proxyUsage.byTargetId}
        instanceOptions={instanceOptions}
        runtimeByTargetId={runtimeByTargetId}
        runtimeRefreshing={runtimeQuery.isFetching}
        deletePending={deleteTargetMutation.isPending}
        onEdit={(target: ApiProxyTargetRecord) => {
          setTargetEditor({ mode: "edit", target });
          setTargetDraft(targetDraftFromRecord(target));
        }}
        onDelete={(id) => deleteTargetMutation.mutate(id)}
      />

      <TargetEditorModal
        editor={targetEditor}
        draft={targetDraft}
        busy={targetBusy}
        slotSaveAvailable={slotSaveAvailable}
        onClose={closeTargetEditor}
        onSave={saveTarget}
        onDraftChange={setTargetDraft}
      />
    </Stack>
  );
}
