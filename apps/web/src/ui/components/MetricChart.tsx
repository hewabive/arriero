import { Box, Group, Paper, Text, useComputedColorScheme } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

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
type TimeSpan = { from: number; to: number };

const GRID_DIVISIONS = 4;
const GAP_TOLERANCE = 2.5;
const CEILING_HEADROOM = 12;
const SATURATION_RATIO = 0.995;
const SATURATION_MARK_HEIGHT = 3;
const SATURATION_MARK_MIN_WIDTH = 2;
const TOOLTIP_WIDTH = 148;

type MetricHoverState = {
  time: number | null;
  setTime: (time: number | null) => void;
};

const MetricHoverContext = createContext<MetricHoverState | null>(null);

export function MetricHoverProvider(props: { children: ReactNode }) {
  const [time, setTime] = useState<number | null>(null);
  const state = useMemo(() => ({ time, setTime }), [time]);
  return (
    <MetricHoverContext.Provider value={state}>
      {props.children}
    </MetricHoverContext.Provider>
  );
}

function useMetricHover(): MetricHoverState {
  const shared = useContext(MetricHoverContext);
  const [time, setTime] = useState<number | null>(null);
  const isolated = useMemo(() => ({ time, setTime }), [time]);
  return shared ?? isolated;
}

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

function nearestIndex(times: number[], time: number): number | null {
  let nearest: number | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  times.forEach((value, index) => {
    const distance = Math.abs(value - time);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = index;
    }
  });
  return nearest;
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

function saturationSpans(
  values: (number | null)[],
  times: number[],
  threshold: number,
): TimeSpan[] {
  const spans: TimeSpan[] = [];
  let openedAt: number | null = null;
  let lastSaturated: number | null = null;

  values.forEach((value, index) => {
    const time = times[index];
    if (value !== null && time !== undefined && value >= threshold) {
      openedAt ??= time;
      lastSaturated = time;
      return;
    }
    if (openedAt !== null) {
      spans.push({ from: openedAt, to: lastSaturated ?? openedAt });
      openedAt = null;
    }
  });

  if (openedAt !== null) {
    spans.push({ from: openedAt, to: lastSaturated ?? openedAt });
  }
  return spans;
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
  const hover = useMetricHover();
  const [pointerInside, setPointerInside] = useState(false);
  const svgHeight = props.height ?? 120;
  const { times, windowMs, intervalMs } = props.axis;

  const gridColor =
    colorScheme === "dark"
      ? "var(--mantine-color-dark-5)"
      : "var(--mantine-color-gray-2)";
  const frameColor =
    colorScheme === "dark"
      ? "var(--mantine-color-dark-3)"
      : "var(--mantine-color-gray-4)";
  const cursorColor =
    colorScheme === "dark"
      ? "var(--mantine-color-dark-2)"
      : "var(--mantine-color-gray-5)";
  const surfaceColor = "var(--mantine-color-body)";

  const max = useMemo(
    () => resolveMax(props.domain, props.series),
    [props.domain, props.series],
  );

  const plotTop = CEILING_HEADROOM;
  const plotBottom = svgHeight - 1;
  const plotHeight = plotBottom - plotTop;
  const latestTime = times[times.length - 1] ?? 0;
  const startTime = latestTime - windowMs;
  const plotWidth = Math.max(width, 1);

  const scaleX = (time: number) => ((time - startTime) / windowMs) * plotWidth;
  const scaleY = (value: number) =>
    plotBottom - Math.min(1, Math.max(0, value / max)) * plotHeight;

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
          area: areaPath(segments, plotBottom),
          line: linePath(segments),
          saturation: saturationSpans(
            entry.values,
            times,
            max * SATURATION_RATIO,
          ),
        };
      }),
    [
      props.series,
      times,
      intervalMs,
      startTime,
      windowMs,
      plotWidth,
      plotTop,
      plotBottom,
      max,
      colorScheme,
    ],
  );

  const hoverIndex =
    hover.time === null ? null : nearestIndex(times, hover.time);
  const hoverTime = hoverIndex === null ? null : (times[hoverIndex] ?? null);
  const cursorX = hoverTime === null ? 0 : scaleX(hoverTime);
  const tooltipFlipped = cursorX + 8 + TOOLTIP_WIDTH > plotWidth;

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const offsetX = event.clientX - bounds.left;
    const time = startTime + (offsetX / Math.max(bounds.width, 1)) * windowMs;
    const index = nearestIndex(times, time);
    setPointerInside(true);
    hover.setTime(index === null ? null : (times[index] ?? null));
  };

  const handlePointerLeave = () => {
    setPointerInside(false);
    hover.setTime(null);
  };

  return (
    <Box>
      <Group justify="space-between" align="baseline" gap="xs" wrap="nowrap">
        <Text fw={600} size="sm" lineClamp={1}>
          {props.title}
        </Text>
        <Text size="sm" fw={700}>
          {props.headline}
        </Text>
      </Group>

      {(props.series.length > 1 || props.domain.kind === "auto") && (
        <Group justify="space-between" gap="xs" mt={4} wrap="nowrap">
          <Group gap="md" wrap="nowrap">
            {props.series.length > 1 &&
              rendered.map((entry) => (
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
          {props.domain.kind === "auto" && (
            <Text c="dimmed" size="xs">
              scale {props.formatValue(max)}
            </Text>
          )}
        </Group>
      )}

      <Box ref={ref} pos="relative" mt={6} style={{ width: "100%" }}>
        <svg
          width="100%"
          height={svgHeight}
          style={{ display: "block", touchAction: "none" }}
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
        >
          {Array.from({ length: GRID_DIVISIONS - 1 }, (_, index) => {
            const y = plotTop + (plotHeight / GRID_DIVISIONS) * (index + 1);
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

          {[plotTop, plotBottom].map((y) => (
            <line
              key={y}
              x1={0}
              x2={plotWidth}
              y1={y}
              y2={y}
              stroke={frameColor}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          ))}

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

          {rendered.map((entry) =>
            entry.saturation.map((span) => {
              const from = scaleX(span.from);
              const to = scaleX(span.to);
              return (
                <rect
                  key={`${entry.id}-saturation-${span.from}`}
                  x={from}
                  y={plotTop - SATURATION_MARK_HEIGHT - 1}
                  width={Math.max(to - from, SATURATION_MARK_MIN_WIDTH)}
                  height={SATURATION_MARK_HEIGHT}
                  rx={1}
                  fill={entry.color}
                />
              );
            }),
          )}

          {hoverTime !== null && (
            <line
              x1={cursorX}
              x2={cursorX}
              y1={plotTop}
              y2={plotBottom}
              stroke={cursorColor}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          )}

          {hoverIndex !== null &&
            rendered.map((entry) => {
              const value = entry.values[hoverIndex];
              if (value === null || value === undefined) {
                return null;
              }
              return (
                <circle
                  key={`${entry.id}-dot`}
                  cx={cursorX}
                  cy={scaleY(value)}
                  r={4}
                  fill={entry.color}
                  stroke={surfaceColor}
                  strokeWidth={2}
                />
              );
            })}
        </svg>

        {times.length === 0 && (
          <Text
            c="dimmed"
            size="xs"
            pos="absolute"
            top="50%"
            left={0}
            w="100%"
            ta="center"
            style={{ pointerEvents: "none", transform: "translateY(-50%)" }}
          >
            waiting for samples
          </Text>
        )}

        {pointerInside && hoverIndex !== null && hoverTime !== null && (
          <Paper
            withBorder
            p={6}
            radius="sm"
            pos="absolute"
            top={0}
            left={Math.max(
              tooltipFlipped ? cursorX - 8 - TOOLTIP_WIDTH : cursorX + 8,
              0,
            )}
            style={{ pointerEvents: "none", width: TOOLTIP_WIDTH }}
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
                      w={10}
                      h={2}
                      style={{ background: entry.color, borderRadius: 1 }}
                    />
                    <Text c="dimmed" size="xs">
                      {entry.label}
                    </Text>
                  </Group>
                  <Text size="xs" fw={700}>
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
    </Box>
  );
}
