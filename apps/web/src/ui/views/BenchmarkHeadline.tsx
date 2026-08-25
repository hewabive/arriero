import type { BenchmarkRunSummary } from "@arriero/core";
import { Paper, SimpleGrid, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";

import {
  formatDurationMs,
  formatPercent,
  formatRate,
  formatTokens,
} from "./benchmark-format";

function Stat(props: {
  label: string;
  value: string;
  unit?: string;
  hint?: ReactNode;
}) {
  return (
    <Paper withBorder p="xs" radius="sm">
      <Stack gap={2}>
        <Text size="xs" c="dimmed">
          {props.label}
        </Text>
        <Text size="lg" fw={700} lh={1.2}>
          {props.value}
          {props.unit && (
            <Text span size="xs" c="dimmed" fw={500}>
              {` ${props.unit}`}
            </Text>
          )}
        </Text>
        <Text size="xs" c="dimmed" lh={1.3}>
          {props.hint ?? " "}
        </Text>
      </Stack>
    </Paper>
  );
}

function contentionHint(
  perRequest: number | null,
  solo: number | null,
): ReactNode {
  if (perRequest === null || solo === null || solo <= 0) {
    return "no solo baseline";
  }
  const delta = perRequest / solo - 1;
  if (Math.abs(delta) < 0.005) {
    return "at solo baseline";
  }
  return (
    <Text span size="xs" c={delta < 0 ? "orange" : "teal"}>
      {`${delta > 0 ? "+" : "−"}${Math.abs(delta * 100).toFixed(0)}% vs solo ${solo.toFixed(1)}`}
    </Text>
  );
}

export function BenchmarkHeadline({
  summary,
}: {
  summary: BenchmarkRunSummary;
}) {
  const headline = summary.headline;
  if (!headline) {
    return null;
  }
  return (
    <SimpleGrid minColWidth="9rem" autoFlow="auto-fit" spacing="xs">
      <Stat
        label="Decode total"
        value={formatRate(headline.decodeTokensPerSecond)}
        unit="tok/s"
        hint={`peak ${headline.peakConcurrentDecode} decoding at once`}
      />
      <Stat
        label="Decode per request"
        value={formatRate(headline.perRequestDecodeTokensPerSecond)}
        unit="tok/s"
        hint={contentionHint(
          headline.perRequestDecodeTokensPerSecond,
          headline.soloDecodeTokensPerSecond,
        )}
      />
      <Stat
        label="TTFT p50"
        value={formatDurationMs(headline.timeToFirstTokenP50Ms)}
        hint={`p95 ${formatDurationMs(headline.timeToFirstTokenP95Ms)}`}
      />
      <Stat
        label="Prefill"
        value={formatRate(headline.prefillTokensPerSecond)}
        unit="tok/s"
        hint={`${formatTokens(headline.totalPromptTokens)} prompt tokens`}
      />
      <Stat
        label="Draft acceptance"
        value={formatPercent(summary.acceptanceRate)}
        hint={
          summary.acceptanceRate === null
            ? "no speculative decoding"
            : "weighted by drafted tokens"
        }
      />
      <Stat
        label="Output"
        value={formatTokens(summary.totalCompletionTokens)}
        unit="tokens"
        hint={`${(summary.wallMs / 1000).toFixed(1)} s wall`}
      />
    </SimpleGrid>
  );
}
