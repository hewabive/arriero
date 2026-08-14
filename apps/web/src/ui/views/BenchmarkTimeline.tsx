import type { BenchmarkRunResult } from "@arriero/core";
import {
  Group,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Title,
  useComputedColorScheme,
} from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { useMemo, useState } from "react";

import { metricToneColor } from "../components/metric-palette";

const LEFT_GUTTER = 140;
const RIGHT_PAD = 12;
const ROW_HEIGHT = 22;
const BAR_HEIGHT = 12;
const LANE_HEIGHT = 64;
const LANE_GAP = 14;
const AXIS_HEIGHT = 22;
const TOP_PAD = 6;

function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
}

export function BenchmarkTimeline({ result }: { result: BenchmarkRunResult }) {
  const colorScheme = useComputedColorScheme("dark");
  const { ref, width } = useElementSize();
  const repetitions = useMemo(
    () =>
      [...new Set(result.requests.map((request) => request.repetition))].sort(
        (a, b) => a - b,
      ),
    [result],
  );
  const [repetition, setRepetition] = useState<number>(repetitions[0] ?? 0);
  const activeRepetition = repetitions.includes(repetition)
    ? repetition
    : (repetitions[0] ?? 0);

  const requests = result.requests.filter(
    (request) =>
      request.repetition === activeRepetition &&
      request.firstTokenMs !== null &&
      request.doneMs !== null,
  );
  const segments = result.segments.filter(
    (segment) => segment.repetition === activeRepetition,
  );

  if (requests.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        No measurable requests in this repetition.
      </Text>
    );
  }

  const t0 = Math.min(...requests.map((request) => request.submitMs));
  const t1 = Math.max(...requests.map((request) => request.doneMs ?? 0));
  const span = Math.max(1, t1 - t0);
  const plotWidth = Math.max(50, width - LEFT_GUTTER - RIGHT_PAD);
  const x = (ms: number) => LEFT_GUTTER + ((ms - t0) / span) * plotWidth;

  const rowsHeight = requests.length * ROW_HEIGHT;
  const laneTop = TOP_PAD + rowsHeight + LANE_GAP;
  const height = laneTop + LANE_HEIGHT + AXIS_HEIGHT;

  const prefillColor = metricToneColor("outbound", colorScheme);
  const decodeColor = metricToneColor("memory", colorScheme);
  const rateColor = metricToneColor("cpu", colorScheme);
  const queueColor = "var(--mantine-color-gray-5)";
  const gridColor = "var(--mantine-color-default-border)";

  const maxRate = niceCeiling(
    Math.max(
      1,
      ...segments.map((segment) => segment.decodeTokensPerSecond ?? 0),
    ),
  );
  const rateY = (rate: number) =>
    laneTop + LANE_HEIGHT - (rate / maxRate) * LANE_HEIGHT;

  const ratePath = segments
    .filter((segment) => segment.decodeTokensPerSecond !== null)
    .map((segment) => {
      const y = rateY(segment.decodeTokensPerSecond ?? 0);
      return `M ${x(segment.startMs).toFixed(1)} ${y.toFixed(1)} H ${x(segment.endMs).toFixed(1)}`;
    })
    .join(" ");

  const tickCount = 5;
  const ticks = Array.from(
    { length: tickCount + 1 },
    (_, index) => t0 + (span * index) / tickCount,
  );

  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="wrap">
        <Title order={4}>Timeline</Title>
        {repetitions.length > 1 && (
          <SegmentedControl
            size="xs"
            value={String(activeRepetition)}
            onChange={(value) => setRepetition(Number(value))}
            data={repetitions.map((value) => ({
              value: String(value),
              label: `Wave ${value + 1}`,
            }))}
          />
        )}
      </Group>
      <Paper withBorder p="xs" radius="sm" ref={ref}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label="Benchmark request timeline"
          >
            {segments
              .filter((segment) => segment.prefillCount > 0)
              .map((segment, index) => (
                <rect
                  key={`band-${index}`}
                  x={x(segment.startMs)}
                  y={TOP_PAD}
                  width={Math.max(1, x(segment.endMs) - x(segment.startMs))}
                  height={rowsHeight + LANE_GAP + LANE_HEIGHT}
                  fill={prefillColor}
                  opacity={0.09}
                />
              ))}
            {ticks.map((tick, index) => (
              <g key={`tick-${index}`}>
                <line
                  x1={x(tick)}
                  y1={TOP_PAD}
                  x2={x(tick)}
                  y2={laneTop + LANE_HEIGHT}
                  stroke={gridColor}
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <text
                  x={x(tick)}
                  y={laneTop + LANE_HEIGHT + 14}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--mantine-color-dimmed)"
                >
                  {formatSeconds(tick - t0)}
                </text>
              </g>
            ))}
            {requests.map((request, index) => {
              const y =
                TOP_PAD + index * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2;
              const firstToken = request.firstTokenMs ?? request.submitMs;
              const done = request.doneMs ?? firstToken;
              const prefillStart = request.prefillStartMs ?? request.submitMs;
              const tokensPerSecond = request.clientDecodeTokensPerSecond;
              return (
                <g key={request.requestId}>
                  <text
                    x={LEFT_GUTTER - 8}
                    y={y + BAR_HEIGHT - 2}
                    textAnchor="end"
                    fontSize={10}
                    fill="var(--mantine-color-dimmed)"
                  >
                    {`${request.topic}/${request.language}`}
                  </text>
                  {request.prefillStartMs !== null &&
                    request.prefillStartMs > request.submitMs && (
                      <rect
                        x={x(request.submitMs)}
                        y={y + 3}
                        width={Math.max(
                          1,
                          x(prefillStart) - x(request.submitMs),
                        )}
                        height={BAR_HEIGHT - 6}
                        fill={queueColor}
                        opacity={0.6}
                      >
                        <title>{`queue ${(prefillStart - request.submitMs).toFixed(0)} ms`}</title>
                      </rect>
                    )}
                  <rect
                    x={x(prefillStart)}
                    y={y}
                    width={Math.max(1, x(firstToken) - x(prefillStart))}
                    height={BAR_HEIGHT}
                    fill={prefillColor}
                  >
                    <title>{`prefill ${(firstToken - prefillStart).toFixed(0)} ms · ${request.promptTokens ?? "?"} tokens`}</title>
                  </rect>
                  <rect
                    x={x(firstToken)}
                    y={y}
                    width={Math.max(1, x(done) - x(firstToken))}
                    height={BAR_HEIGHT}
                    fill={decodeColor}
                  >
                    <title>{`decode ${(done - firstToken).toFixed(0)} ms · ${request.completionTokens ?? "?"} tokens${tokensPerSecond !== null ? ` · ${tokensPerSecond.toFixed(1)} tok/s` : ""}`}</title>
                  </rect>
                </g>
              );
            })}
            <line
              x1={LEFT_GUTTER}
              y1={laneTop + LANE_HEIGHT}
              x2={LEFT_GUTTER + plotWidth}
              y2={laneTop + LANE_HEIGHT}
              stroke={gridColor}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            {ratePath && (
              <path
                d={ratePath}
                stroke={rateColor}
                strokeWidth={1.5}
                fill="none"
              />
            )}
            <text
              x={LEFT_GUTTER - 8}
              y={laneTop + 10}
              textAnchor="end"
              fontSize={10}
              fill="var(--mantine-color-dimmed)"
            >
              {`${maxRate} tok/s`}
            </text>
            <text
              x={LEFT_GUTTER - 8}
              y={laneTop + LANE_HEIGHT - 2}
              textAnchor="end"
              fontSize={10}
              fill="var(--mantine-color-dimmed)"
            >
              0
            </text>
          </svg>
        )}
      </Paper>
      <Group gap="md" wrap="wrap">
        <Group gap={6}>
          <span
            style={{
              width: 10,
              height: 10,
              background: prefillColor,
              display: "inline-block",
              borderRadius: 2,
            }}
          />
          <Text size="xs" c="dimmed">
            prefill
          </Text>
        </Group>
        <Group gap={6}>
          <span
            style={{
              width: 10,
              height: 10,
              background: decodeColor,
              display: "inline-block",
              borderRadius: 2,
            }}
          />
          <Text size="xs" c="dimmed">
            decode
          </Text>
        </Group>
        <Group gap={6}>
          <span
            style={{
              width: 10,
              height: 10,
              background: rateColor,
              display: "inline-block",
              borderRadius: 2,
            }}
          />
          <Text size="xs" c="dimmed">
            total decode tok/s
          </Text>
        </Group>
        <Text size="xs" c="dimmed">
          shaded bands = a prefill is competing for batch capacity
        </Text>
      </Group>
    </Stack>
  );
}
