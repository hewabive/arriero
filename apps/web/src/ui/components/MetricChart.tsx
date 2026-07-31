import { Box, Group, Paper, Text, useComputedColorScheme } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { useMemo, useState } from "react";

import { formatLocalClock, formatLocalDateTime } from "../utils/time";
import { metricToneColor, type MetricTone } from "./metric-palette";

export type MetricSeries = {
  id: string;
  label: string;
  tone: MetricTone;
  values: (number | null)[];
};

export type MetricAxis = {
  times: number[];
  windowMs: number;
  intervalMs: number;
};

export type MetricDomain =
  | { kind: "fixed"; max: number }
  | { kind: "auto"; minimumMax: number };

type MetricChartProps = {
  title: string;
  headline: string;
  series: MetricSeries[];
  axis: MetricAxis;
  domain: MetricDomain;
  formatValue: (value: number) => string;
  height?: number;
};

type PlotPoint = { x: number; y: number };

const GRID_DIVISIONS = 4;
const GAP_TOLERANCE = 2.5;

function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const normalized = value / base;
  const step =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * base;
}

function resolveMax(domain: MetricDomain, series: MetricSeries[]): number {
  if (domain.kind === "fixed") {
    return domain.max;
  }
  let peak = 0;
  for (const entry of series) {
    for (const value of entry.values) {
      if (value !== null && value > peak) {
        peak = value;
      }
    }
  }
  return Math.max(domain.minimumMax, niceCeiling(peak));
}

function buildSegments(
  values: (number | null)[],
  times: number[],
  scaleX: (time: number) => number,
  scaleY: (value: number) => number,
  gapMs: number,
): PlotPoint[][] {
  const segments: PlotPoint[][] = [];
  let current: PlotPoint[] = [];

  values.forEach((value, index) => {
    const time = times[index];
    const previousTime = times[index - 1];
    const broken =
      value === null ||
      time === undefined ||
      (previousTime !== undefined && time - previousTime > gapMs);
    if (broken) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      if (value === null || time === undefined) {
        return;
      }
    }
    current.push({ x: scaleX(time), y: scaleY(value) });
  });

  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

function linePath(segments: PlotPoint[][]): string {
  return segments
    .filter((segment) => segment.length > 1)
    .map(
      (segment) =>
        `M${segment.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join("L")}`,
    )
    .join(" ");
}

function areaPath(segments: PlotPoint[][], baseline: number): string {
  return segments
    .filter((segment) => segment.length > 1)
    .map((segment) => {
      const first = segment[0]!;
      const last = segment[segment.length - 1]!;
      const body = segment
        .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
        .join("L");
      return `M${first.x.toFixed(2)},${baseline}L${body}L${last.x.toFixed(2)},${baseline}Z`;
    })
    .join(" ");
}

export function MetricChart(props: MetricChartProps) {
  const colorScheme = useComputedColorScheme("dark");
  const { ref, width } = useElementSize();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const height = props.height ?? 120;
  const { times, windowMs, intervalMs } = props.axis;

  const gridColor =
    colorScheme === "dark"
      ? "var(--mantine-color-dark-4)"
      : "var(--mantine-color-gray-3)";
  const surfaceColor = "var(--mantine-color-body)";

  const max = useMemo(
    () => resolveMax(props.domain, props.series),
    [props.domain, props.series],
  );

  const latestTime = times[times.length - 1] ?? 0;
  const startTime = latestTime - windowMs;
  const plotWidth = Math.max(width, 1);

  const scaleX = (time: number) => ((time - startTime) / windowMs) * plotWidth;
  const scaleY = (value: number) =>
    height - Math.min(1, Math.max(0, value / max)) * height;

  const rendered = useMemo(
    () =>
      props.series.map((entry) => {
        const segments = buildSegments(
          entry.values,
          times,
          scaleX,
          scaleY,
          GAP_TOLERANCE * intervalMs,
        );
        return {
          ...entry,
          color: metricToneColor(entry.tone, colorScheme),
          segments,
          area: areaPath(segments, height),
          line: linePath(segments),
        };
      }),
    [
      props.series,
      times,
      intervalMs,
      startTime,
      windowMs,
      plotWidth,
      height,
      max,
      colorScheme,
    ],
  );

  const hoverTime = hoverIndex === null ? null : (times[hoverIndex] ?? null);

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const offsetX = event.clientX - bounds.left;
    const time = startTime + (offsetX / Math.max(bounds.width, 1)) * windowMs;
    let nearest: number | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    times.forEach((value, index) => {
      const distance = Math.abs(value - time);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = index;
      }
    });
    setHoverIndex(nearest);
  };

  return (
    <Paper withBorder p="xs" radius="sm">
      <Group justify="space-between" align="baseline" gap="xs" wrap="nowrap">
        <Text fw={600} size="sm" lineClamp={1}>
          {props.title}
        </Text>
        <Text size="sm" fw={700}>
          {props.headline}
        </Text>
      </Group>

      {props.series.length > 1 && (
        <Group gap="md" mt={4}>
          {rendered.map((entry) => (
            <Group key={entry.id} gap={6} wrap="nowrap">
              <Box
                w={10}
                h={2}
                style={{ background: entry.color, borderRadius: 1 }}
              />
              <Text c="dimmed" size="xs">
                {entry.label}
              </Text>
            </Group>
          ))}
        </Group>
      )}

      <Box ref={ref} pos="relative" mt={6} style={{ width: "100%" }}>
        <svg
          width="100%"
          height={height}
          style={{ display: "block", touchAction: "none" }}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverIndex(null)}
        >
          {Array.from({ length: GRID_DIVISIONS + 1 }, (_, index) => {
            const y = (height / GRID_DIVISIONS) * index;
            return (
              <line
                key={index}
                x1={0}
                x2={plotWidth}
                y1={y}
                y2={y}
                stroke={gridColor}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
            );
          })}

          {rendered.map((entry) => (
            <path
              key={`${entry.id}-area`}
              d={entry.area}
              fill={entry.color}
              fillOpacity={0.1}
            />
          ))}

          {rendered.map((entry) => (
            <path
              key={`${entry.id}-line`}
              d={entry.line}
              fill="none"
              stroke={entry.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {hoverTime !== null && (
            <line
              x1={scaleX(hoverTime)}
              x2={scaleX(hoverTime)}
              y1={0}
              y2={height}
              stroke={gridColor}
              strokeWidth={1}
            />
          )}

          {hoverTime !== null &&
            hoverIndex !== null &&
            rendered.map((entry) => {
              const value = entry.values[hoverIndex];
              if (value === null || value === undefined) {
                return null;
              }
              return (
                <circle
                  key={`${entry.id}-dot`}
                  cx={scaleX(hoverTime)}
                  cy={scaleY(value)}
                  r={4}
                  fill={entry.color}
                  stroke={surfaceColor}
                  strokeWidth={2}
                />
              );
            })}
        </svg>

        <Text
          c="dimmed"
          size="xs"
          pos="absolute"
          top={2}
          right={4}
          style={{ pointerEvents: "none" }}
        >
          {props.formatValue(max)}
        </Text>

        {hoverIndex !== null && hoverTime !== null && (
          <Paper
            withBorder
            p={6}
            radius="sm"
            pos="absolute"
            top={0}
            left={Math.min(
              Math.max(scaleX(hoverTime) + 8, 0),
              Math.max(plotWidth - 150, 0),
            )}
            style={{ pointerEvents: "none", minWidth: 130 }}
          >
            <Text c="dimmed" size="xs">
              {windowMs > 24 * 60 * 60 * 1000
                ? formatLocalDateTime(hoverTime)
                : formatLocalClock(hoverTime)}
            </Text>
            {rendered.map((entry) => {
              const value = entry.values[hoverIndex];
              return (
                <Group
                  key={entry.id}
                  gap={6}
                  justify="space-between"
                  wrap="nowrap"
                >
                  <Group gap={6} wrap="nowrap">
                    <Box
                      w={8}
                      h={8}
                      style={{ background: entry.color, borderRadius: 4 }}
                    />
                    <Text size="xs">{entry.label}</Text>
                  </Group>
                  <Text size="xs" fw={600}>
                    {value === null || value === undefined
                      ? "-"
                      : props.formatValue(value)}
                  </Text>
                </Group>
              );
            })}
          </Paper>
        )}
      </Box>
    </Paper>
  );
}
