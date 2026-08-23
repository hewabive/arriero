import {
  API_PROXY_REASONING_LEVELS,
  apiProxyReasoningLevelBudgets,
  apiProxyReasoningPresets,
  projectApiProxyReasoningLevel,
  type ApiProxyModelReasoning,
  type ApiProxyModelRecord,
  type ApiProxyReasoningInterface,
  type ApiProxyReasoningLevel,
  type ApiProxyReasoningProfile,
} from "@arriero/core";
import { Badge, Group, Stack, Table, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  getApiProxyConfig,
  getInstanceReasoningProfile,
} from "../../api/client";
import { computeInstanceProxyBindings } from "../proxy/instance-refs";

const interfaceLabels: Record<ApiProxyReasoningInterface, string> = {
  "template-effort": "Template effort levels",
  budget: "Thinking token budget",
  "enable-flag": "Thinking on/off",
  passthrough: "Passthrough",
  none: "Non-reasoning",
};

function sourceLabel(source: string) {
  return source === "template" ? "chat-template autodetect" : source;
}

function propsSupportsReasoningEffort(body: unknown): boolean | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const caps = (body as Record<string, unknown>).chat_template_caps;
  if (typeof caps !== "object" || caps === null) {
    return null;
  }
  const value = (caps as Record<string, unknown>).supports_reasoning_effort;
  return typeof value === "boolean" ? value : null;
}

type RemapRow = {
  requested: ApiProxyReasoningLevel;
  sent: ApiProxyReasoningLevel;
  via: "alias" | "nearest supported";
};

function remappedLevels(profile: ApiProxyReasoningProfile): RemapRow[] {
  return API_PROXY_REASONING_LEVELS.flatMap((requested) => {
    const sent = projectApiProxyReasoningLevel(requested, profile);
    if (sent === requested) {
      return [];
    }
    return [
      {
        requested,
        sent,
        via:
          profile.aliases[requested] === sent
            ? ("alias" as const)
            : ("nearest supported" as const),
      },
    ];
  });
}

function overrideLabel(reasoning: ApiProxyModelReasoning) {
  if (reasoning.kind === "preset") {
    return (
      apiProxyReasoningPresets.find((entry) => entry.id === reasoning.preset)
        ?.label ?? `preset ${reasoning.preset}`
    );
  }
  const levels = reasoning.profile.levels;
  const suffix = levels.length > 0 ? `: ${levels.join("/")}` : "";
  return `custom profile (${reasoning.profile.interface}${suffix})`;
}

function formatBudget(tokens: number) {
  return tokens < 0 ? "unlimited" : String(tokens);
}

function TemplateEffortBlock(props: { profile: ApiProxyReasoningProfile }) {
  if (props.profile.levels.length === 0) {
    return (
      <Text size="sm">
        No level ladder is known for this template — requested levels are sent
        as reasoning_effort unchanged.
      </Text>
    );
  }
  const rows = remappedLevels(props.profile);
  return (
    <Stack gap="xs">
      <Group gap={6}>
        <Text size="sm">Native levels:</Text>
        {props.profile.levels.map((level) => (
          <Badge key={level} color="green" variant="light">
            {level}
          </Badge>
        ))}
      </Group>
      {rows.length > 0 && (
        <Table
          horizontalSpacing="sm"
          verticalSpacing={2}
          w="auto"
          withRowBorders={false}
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Requested</Table.Th>
              <Table.Th>Sent as</Table.Th>
              <Table.Th>Via</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={row.requested}>
                <Table.Td>{row.requested}</Table.Td>
                <Table.Td>{row.sent}</Table.Td>
                <Table.Td>
                  <Text c="dimmed" size="sm">
                    {row.via}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      <Text c="dimmed" size="xs">
        Budget-style requests pick the closest level first; &quot;off&quot; is
        sent as reasoning_effort &quot;none&quot;.
      </Text>
    </Stack>
  );
}

function BudgetBlock(props: { profile: ApiProxyReasoningProfile }) {
  return (
    <Stack gap="xs">
      <Text size="sm">
        Requested effort levels are translated into thinking token budgets:
      </Text>
      <Group gap={6}>
        {API_PROXY_REASONING_LEVELS.map((level) => (
          <Badge key={level} color="gray" variant="light">
            {level}:{" "}
            {formatBudget(
              props.profile.levelBudgets[level] ??
                apiProxyReasoningLevelBudgets[level],
            )}
          </Badge>
        ))}
      </Group>
      <Text c="dimmed" size="xs">
        &quot;off&quot; disables thinking, &quot;auto&quot; keeps the
        engine-default budget, explicit token budgets pass through unchanged.
      </Text>
    </Stack>
  );
}

function interfaceBlock(profile: ApiProxyReasoningProfile) {
  switch (profile.interface) {
    case "template-effort":
      return <TemplateEffortBlock profile={profile} />;
    case "budget":
      return <BudgetBlock profile={profile} />;
    case "enable-flag":
      return (
        <Text size="sm">
          Thinking can only be toggled on or off — any requested level or budget
          just enables it.
        </Text>
      );
    case "passthrough":
      return (
        <Text size="sm">
          Reasoning-capable upstream — effort fields are re-emitted as sent.
        </Text>
      );
    case "none":
      return (
        <Text size="sm">
          Non-reasoning model — effort fields are dropped from requests.
        </Text>
      );
  }
}

function liveConfirmation(
  profile: ApiProxyReasoningProfile,
  supported: boolean | null,
) {
  if (supported === null) {
    return null;
  }
  if (profile.interface === "template-effort") {
    return supported ? (
      <Text c="green" size="xs">
        The running server confirms reasoning-effort support (/props).
      </Text>
    ) : (
      <Text c="yellow" size="xs">
        The running server reports no reasoning-effort support — the detected
        ladder may not match the loaded model.
      </Text>
    );
  }
  if (supported) {
    return (
      <Text c="yellow" size="xs">
        The running server reports reasoning-effort template support, but no
        level ladder was detected — consider a preset override on the proxy
        model.
      </Text>
    );
  }
  return null;
}

export function InstanceReasoningPanel(props: {
  instanceName: string;
  active: boolean;
  llamaPropsBody: unknown;
}) {
  const profileQuery = useQuery({
    queryKey: ["instance-reasoning-profile", props.instanceName],
    queryFn: () => getInstanceReasoningProfile(props.instanceName),
    enabled: props.active,
    staleTime: 10_000,
  });

  const proxyConfigQuery = useQuery({
    queryKey: ["api-proxy-config"],
    queryFn: getApiProxyConfig,
    enabled: props.active,
  });

  const proxyConfig = proxyConfigQuery.data?.data;
  const overrides = useMemo(() => {
    if (!proxyConfig) {
      return [];
    }
    return computeInstanceProxyBindings(
      props.instanceName,
      proxyConfig,
    ).boundModels.flatMap((model: ApiProxyModelRecord) =>
      model.reasoning ? [{ model, reasoning: model.reasoning }] : [],
    );
  }, [proxyConfig, props.instanceName]);

  if (profileQuery.isError) {
    return (
      <Text c="red" size="sm">
        {(profileQuery.error as Error).message}
      </Text>
    );
  }
  if (!profileQuery.data) {
    return (
      <Text c="dimmed" size="sm">
        Loading reasoning profile…
      </Text>
    );
  }

  const resolved = profileQuery.data.data;
  return (
    <Stack gap="sm">
      {resolved === null ? (
        <>
          <Badge color="gray" variant="light" w="fit-content">
            Passthrough
          </Badge>
          <Text size="sm">
            No effort mapping for this engine — client reasoning fields are
            forwarded to the upstream unchanged.
          </Text>
        </>
      ) : (
        <>
          <Group gap="xs">
            <Badge variant="light">
              {interfaceLabels[resolved.profile.interface]}
            </Badge>
            <Text c="dimmed" size="xs">
              resolved from {sourceLabel(resolved.source)}
            </Text>
          </Group>
          {interfaceBlock(resolved.profile)}
          {liveConfirmation(
            resolved.profile,
            propsSupportsReasoningEffort(props.llamaPropsBody),
          )}
        </>
      )}
      {overrides.length > 0 && (
        <Stack gap={4}>
          <Text fw={600} size="sm">
            Proxy-model overrides
          </Text>
          {overrides.map((entry) => (
            <Text key={entry.model.id} size="sm">
              {entry.model.modelId}: {overrideLabel(entry.reasoning)}
            </Text>
          ))}
          <Text c="dimmed" size="xs">
            Requests routed through these proxy models use the override instead
            of the profile above.
          </Text>
        </Stack>
      )}
    </Stack>
  );
}
