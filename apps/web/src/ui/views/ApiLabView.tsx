import type {
  ApiLabProbeProfile,
  Instance,
  InstanceHealthSummary,
} from "@arriero/core";
import { Alert, Group, Select, Stack } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { SELF_NODE_ID } from "../../api/base.js";
import {
  listApiProxySources,
  listNodes,
  runApiLabProbe,
  streamApiLabProbe,
} from "../../api/client";
import { useActiveNode } from "../NodeContext.js";
import {
  ApiProbePanel,
  type ProbeRequestOption,
} from "../components/api-probe/ApiProbePanel";
import {
  useEndpointModelCatalog,
  useEndpointModelOptions,
} from "../components/endpoint-model-catalog";
import { SecretInput } from "../components/SecretInput";
import { StatusTooltipIcon } from "../components/StatusTooltipIcon";
import { TouchSelect } from "../components/TouchCombobox";

const profileRequestOptions: Record<ApiLabProbeProfile, ProbeRequestOption[]> =
  {
    openai: [
      { value: "chat", label: "Chat completions" },
      { value: "completion", label: "Completions" },
      { value: "responses", label: "Responses" },
      { value: "embeddings", label: "Embeddings" },
      { value: "rerank", label: "Rerank (/rerank extension)" },
    ],
    "llama-native": [
      { value: "tokenize", label: "Tokenize" },
      { value: "detokenize", label: "Detokenize" },
      { value: "apply-template", label: "Apply template" },
      { value: "infill", label: "Infill" },
    ],
    anthropic: [
      { value: "chat", label: "Messages (chat)" },
      { value: "count-tokens", label: "Count tokens" },
    ],
  };

const protocolLabels: Record<ApiLabProbeProfile, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  "llama-native": "llama.cpp native",
};

const INSTANCE_ENDPOINT_PREFIX = "instance:";

export function ApiLabView(props: {
  instances: Instance[];
  selectedInstance: Instance | null;
  selectedHealth: InstanceHealthSummary | null | undefined;
  onSelect: (instanceId: string) => void;
}) {
  const queryClient = useQueryClient();
  const { activeNodeId } = useActiveNode();
  const [endpointId, setEndpointId] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<ApiLabProbeProfile>("openai");
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const manualApiKey = apiKey.trim();
  const probeTarget = {
    profile: protocol,
    ...(endpointId ? { endpointId } : {}),
    ...(manualApiKey ? { apiKey: manualApiKey } : sourceId ? { sourceId } : {}),
  };

  const { groups, endpointSelectData } = useEndpointModelCatalog(true);
  const selectedGroup = useMemo(
    () => groups.find((group) => group.endpointId === endpointId),
    [groups, endpointId],
  );
  const { modelOptions, status } = useEndpointModelOptions({
    endpointId,
    group: selectedGroup,
  });
  const nativeTargetSelected = selectedGroup?.kind === "managed-instance";

  const nodesQuery = useQuery({
    queryKey: ["nodes"],
    queryFn: listNodes,
    enabled: activeNodeId !== SELF_NODE_ID,
  });
  const activeNodeName =
    activeNodeId === SELF_NODE_ID
      ? null
      : (nodesQuery.data?.data.find((node) => node.id === activeNodeId)?.name ??
        activeNodeId);

  const sourcesQuery = useQuery({
    queryKey: ["api-proxy-sources"],
    queryFn: listApiProxySources,
  });
  const sourceOptions = useMemo(
    () =>
      (sourcesQuery.data?.data ?? [])
        .filter((source) => source.enabled && source.keyConfigured)
        .map((source) => ({ value: source.id, label: source.name })),
    [sourcesQuery.data?.data],
  );

  useEffect(() => {
    setEndpointId(null);
  }, [activeNodeId]);

  useEffect(() => {
    if (endpointId || groups.length === 0) {
      return;
    }
    const managerProxy = groups.find((group) => group.kind === "manager-proxy");
    if (managerProxy) {
      setEndpointId(managerProxy.endpointId);
      return;
    }
    if (props.selectedInstance) {
      const candidate = `${INSTANCE_ENDPOINT_PREFIX}${props.selectedInstance.name}`;
      if (groups.some((group) => group.endpointId === candidate)) {
        setEndpointId(candidate);
      }
    }
  }, [endpointId, groups, props.selectedInstance]);

  useEffect(() => {
    if (protocol === "llama-native" && !nativeTargetSelected) {
      setProtocol("openai");
    }
  }, [protocol, nativeTargetSelected]);

  useEffect(() => {
    if (
      sourceId &&
      !sourceOptions.some((option) => option.value === sourceId)
    ) {
      setSourceId(null);
    }
  }, [sourceId, sourceOptions]);

  const protocolOptions = useMemo(() => {
    const profiles: ApiLabProbeProfile[] = nativeTargetSelected
      ? ["openai", "anthropic", "llama-native"]
      : ["openai", "anthropic"];
    return profiles.map((profile) => ({
      value: profile,
      label: protocolLabels[profile],
    }));
  }, [nativeTargetSelected]);

  const selectEndpoint = (value: string | null) => {
    setEndpointId(value);
    if (value?.startsWith(INSTANCE_ENDPOINT_PREFIX)) {
      props.onSelect(value.slice(INSTANCE_ENDPOINT_PREFIX.length));
    }
  };

  const requestOptions = profileRequestOptions[protocol];

  return (
    <Stack gap="md">
      {activeNodeName ? (
        <Alert color="blue" title={`Probing remote node: ${activeNodeName}`}>
          Targets, models and the arriero proxy below are {activeNodeName}
          &apos;s — the probe runs on that node. Switch to the main node to test
          the fleet proxy and its published models.
        </Alert>
      ) : null}
      <Group align="flex-end" gap="sm" wrap="wrap">
        <Select
          label="Protocol / API"
          data={protocolOptions}
          value={protocol}
          allowDeselect={false}
          onChange={(value) => {
            if (value) {
              setProtocol(value as ApiLabProbeProfile);
            }
          }}
          style={{ width: 200 }}
        />
        <TouchSelect
          label="Endpoint / provider"
          data={endpointSelectData}
          value={endpointId}
          searchable
          clearable
          placeholder="Select an endpoint"
          nothingFoundMessage="No endpoints — add an instance or external API first"
          maxDropdownHeight={360}
          rightSection={<StatusTooltipIcon status={status} />}
          rightSectionPointerEvents="all"
          style={{ width: "min(100%, 480px)" }}
          onChange={selectEndpoint}
        />
        {sourceOptions.length > 0 && (
          <Select
            clearable
            label="Request source"
            description="Sends the request with this source's API key"
            data={sourceOptions}
            value={sourceId}
            placeholder="Anonymous"
            disabled={manualApiKey.length > 0}
            onChange={setSourceId}
            style={{ width: 220 }}
          />
        )}
        <SecretInput
          label="API key"
          description="Sends the request with this key"
          placeholder="None"
          value={apiKey}
          onChange={(event) => setApiKey(event.currentTarget.value)}
          style={{ width: 240 }}
        />
      </Group>

      <ApiProbePanel
        instanceId="api-lab"
        title="API probe"
        disabledReason={endpointId ? null : "Select an endpoint."}
        modelOptions={modelOptions}
        requestOptions={requestOptions}
        autoloadVisible={protocol === "llama-native"}
        runProbe={(probe) => runApiLabProbe({ ...probeTarget, probe })}
        streamProbe={(_id, probe, callbacks, signal) =>
          streamApiLabProbe({ ...probeTarget, probe }, callbacks, signal)
        }
        invalidateInstanceQueries={false}
        onProbeSettled={() => {
          void queryClient.invalidateQueries({
            queryKey: ["api-proxy-runtime"],
          });
          if (props.selectedInstance) {
            void queryClient.invalidateQueries({
              queryKey: [
                "instance-health-summary",
                props.selectedInstance.name,
              ],
            });
          }
        }}
      />
    </Stack>
  );
}
