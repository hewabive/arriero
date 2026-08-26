import type { ApiEndpointRecord, ApiEndpointUpdate } from "@arriero/core";
import { Paper, Stack } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import {
  createApiEndpoint,
  deleteApiEndpoint,
  getApiProxyConfig,
  listRemoteEndpoints,
  updateApiEndpoint,
} from "../../api/client";
import { EndpointEditorModal } from "../endpoints/editor";
import {
  emptyEndpointDraft,
  endpointDraftFromRecord,
  endpointPayload,
  type EndpointDraft,
  type EndpointEditor,
} from "../endpoints/forms";
import { ApiEndpointsSection } from "../endpoints/section";
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS,
  StreamIdleTimeoutInput,
  streamIdleMsFromSeconds,
  streamIdleSecondsFromMs,
} from "../endpoints/stream-idle-input";
import { useApiProxySettings } from "../proxy/use-api-proxy-settings";
import { notifyError } from "../utils/notify";

function StreamIdleTimeoutSetting() {
  const { query, mutation, settings } = useApiProxySettings(
    notifyError("Settings update failed"),
  );
  const stored = settings?.streamIdleTimeoutMs ?? null;
  const [draft, setDraft] = useState<number | null | undefined>(undefined);
  const commit = () => {
    if (draft === undefined) {
      return;
    }
    const next = streamIdleMsFromSeconds(draft);
    if (next === stored) {
      setDraft(undefined);
      return;
    }
    mutation.mutate(
      { streamIdleTimeoutMs: next },
      { onSuccess: () => setDraft(undefined) },
    );
  };
  return (
    <Paper withBorder p="md" radius="sm">
      <StreamIdleTimeoutInput
        description={`Proxy-wide default: a streaming response is aborted when the upstream sends nothing for this long. Empty = ${DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS} s, 0 disables the watchdog; endpoints can override it.`}
        placeholder={String(DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS)}
        maw={520}
        disabled={query.isPending || mutation.isPending}
        value={draft !== undefined ? draft : streamIdleSecondsFromMs(stored)}
        onChange={setDraft}
        onBlur={commit}
      />
    </Paper>
  );
}

export function ApiEndpointsView() {
  const queryClient = useQueryClient();
  const [endpointEditor, setEndpointEditor] = useState<EndpointEditor | null>(
    null,
  );
  const [endpointDraftState, setEndpointDraftState] =
    useState<EndpointDraft>(emptyEndpointDraft);

  const proxyQuery = useQuery({
    queryKey: ["api-proxy-config"],
    queryFn: getApiProxyConfig,
  });
  const remoteQuery = useQuery({
    queryKey: ["api-proxy-remote-endpoints"],
    queryFn: listRemoteEndpoints,
  });

  const targets = proxyQuery.data?.data.targets ?? [];
  const endpoints = useMemo(() => {
    const byId = new Map<string, ApiEndpointRecord>();
    for (const endpoint of proxyQuery.data?.data.endpoints ?? []) {
      byId.set(endpoint.id, endpoint);
    }
    for (const endpoint of remoteQuery.data?.data ?? []) {
      if (!byId.has(endpoint.id)) {
        byId.set(endpoint.id, endpoint);
      }
    }
    return [...byId.values()];
  }, [proxyQuery.data, remoteQuery.data]);
  const targetCountByEndpointId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const target of targets) {
      counts.set(target.endpointId, (counts.get(target.endpointId) ?? 0) + 1);
    }
    return counts;
  }, [targets]);

  const invalidateEndpoints = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["api-proxy-config"] }),
      queryClient.invalidateQueries({ queryKey: ["api-proxy-runtime"] }),
    ]);
  };

  const createEndpointMutation = useMutation({
    mutationFn: createApiEndpoint,
    onSuccess: async () => {
      await invalidateEndpoints();
      closeEndpointEditor();
      notifications.show({
        title: "API endpoint saved",
        message: "Endpoint is available for proxy targets and API Lab.",
      });
    },
    onError: notifyError("API endpoint save failed"),
  });
  const updateEndpointMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ApiEndpointUpdate }) =>
      updateApiEndpoint(id, input),
    onSuccess: async () => {
      await invalidateEndpoints();
      closeEndpointEditor();
      notifications.show({
        title: "API endpoint updated",
        message: "Configuration was saved.",
      });
    },
    onError: notifyError("API endpoint update failed"),
  });
  const deleteEndpointMutation = useMutation({
    mutationFn: deleteApiEndpoint,
    onSuccess: async () => {
      await invalidateEndpoints();
      notifications.show({
        title: "API endpoint deleted",
        message: "Endpoint was removed.",
      });
    },
    onError: notifyError("API endpoint delete failed"),
  });

  function openCreateEndpoint() {
    setEndpointEditor({ mode: "create", endpoint: null });
    setEndpointDraftState(emptyEndpointDraft);
  }

  function openEditEndpoint(endpoint: ApiEndpointRecord) {
    if (!endpoint.editable || endpoint.nodeId) {
      return;
    }
    setEndpointEditor({ mode: "edit", endpoint });
    setEndpointDraftState(endpointDraftFromRecord(endpoint));
  }

  function closeEndpointEditor() {
    setEndpointEditor(null);
    setEndpointDraftState(emptyEndpointDraft);
  }

  function saveEndpoint() {
    const input = endpointPayload(endpointDraftState);
    if (endpointEditor?.mode === "edit") {
      updateEndpointMutation.mutate({
        id: endpointEditor.endpoint.id,
        input,
      });
      return;
    }
    createEndpointMutation.mutate(input);
  }

  const endpointBusy =
    createEndpointMutation.isPending || updateEndpointMutation.isPending;

  return (
    <Stack gap="md">
      <ApiEndpointsSection
        endpoints={endpoints}
        targetCountByEndpointId={targetCountByEndpointId}
        deletePending={deleteEndpointMutation.isPending}
        onCreate={openCreateEndpoint}
        onEdit={openEditEndpoint}
        onDelete={(id) => deleteEndpointMutation.mutate(id)}
      />

      <StreamIdleTimeoutSetting />

      <EndpointEditorModal
        editor={endpointEditor}
        draft={endpointDraftState}
        busy={endpointBusy}
        onClose={closeEndpointEditor}
        onSave={saveEndpoint}
        onDraftChange={setEndpointDraftState}
      />
    </Stack>
  );
}
