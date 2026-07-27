import type { EndpointProbe, PromptCacheState } from "@arriero/core";
import {
  Badge,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { type ReactNode } from "react";

import { formatLocalDateTime } from "../utils/time";
import { probeColor, probeTooltip } from "./instance-details-helpers";

export function ProbePill(props: {
  title: string;
  probe: EndpointProbe | undefined;
}) {
  return (
    <Tooltip label={probeTooltip(props.probe)} withArrow multiline maw={320}>
      <Badge
        color={probeColor(props.probe)}
        variant="light"
        styles={{ root: { textTransform: "none" } }}
      >
        {props.title}: {props.probe?.status ?? "offline"}
      </Badge>
    </Tooltip>
  );
}

export function SectionLabel(props: { children: ReactNode }) {
  return (
    <Text fw={700} size="xs" tt="uppercase" c="dimmed" mt="xs">
      {props.children}
    </Text>
  );
}

function PromptCacheStat(props: { label: string; value: string }) {
  return (
    <Stack gap={0}>
      <Text c="dimmed" size="xs">
        {props.label}
      </Text>
      <Text size="sm" fw={600}>
        {props.value}
      </Text>
    </Stack>
  );
}

export function PromptCachePanel(props: { state: PromptCacheState | null }) {
  const { state } = props;
  return (
    <Paper withBorder p="sm" radius="sm">
      <Group justify="space-between" mb={state ? "xs" : 0}>
        <Stack gap={2}>
          <Text fw={600} size="sm">
            Prompt cache (RAM)
          </Text>
          <Text c="dimmed" size="xs">
            Saved slot snapshots in `--cache-ram` (server_prompt_cache), parsed
            from logs — distinct from the live per-slot cache above.
          </Text>
        </Stack>
        {state && (
          <Badge variant="light" color="blue">
            {`${state.prompts} snapshot${state.prompts === 1 ? "" : "s"}`}
          </Badge>
        )}
      </Group>
      {state ? (
        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
          <PromptCacheStat label="Snapshots" value={String(state.prompts)} />
          <PromptCacheStat
            label="Size"
            value={`${state.sizeMiB.toFixed(1)} MiB`}
          />
          <PromptCacheStat
            label="Limit"
            value={
              state.limitMiB === null
                ? "no limit"
                : `${state.limitMiB.toFixed(0)} MiB`
            }
          />
          <PromptCacheStat
            label="Updated"
            value={formatLocalDateTime(state.at)}
          />
        </SimpleGrid>
      ) : (
        <Text size="xs" c="dimmed">
          No data yet — appears after the first prompt-cache save/load, and only
          for instances launched by the current manager process.
        </Text>
      )}
    </Paper>
  );
}
