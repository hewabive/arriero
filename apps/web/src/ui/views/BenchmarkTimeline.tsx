import {
  BENCHMARK_CLASS_MIN_WALL_MS,
  soloDecodeBaseline,
  type BenchmarkRequestResult,
  type BenchmarkRunResult,
  type BenchmarkSegment,
} from "@arriero/core";
import {
  Box,
  Group,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Title,
  useComputedColorScheme,
} from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import {
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { metricToneColor } from "../components/metric-palette";
import { countLabel } from "../utils/plural";

const RIGHT_GUTTER = 120;
const ROWS_TOP = 20;
const HEADER_BASELINE = 10;
const BAND_MARK_TOP = 14;
const BAND_MARK_HEIGHT = 3;
const LANE_HEIGHT = 76;
const LANE_GAP = 20;
const AXIS_HEIGHT = 20;
const MIN_PLOT_WIDTH = 320;
const MIN_BAR_WIDTH = 1.5;
const MARKER_WIDTH = 7;
const MAX_ROWS = 120;
const MAX_LABEL_CHARS = 30;
const TOOLTIP_WIDTH = 244;
const WAVE_SELECT_THRESHOLD = 6;

type RowShape = {
  request: BenchmarkRequestResult;
  label: string;
  submitMs: number;
  prefillStartMs: number;
  firstTokenMs: number | null;
  doneMs: number | null;
  failed: boolean;
};

type RatePoint = {
  startMs: number;
  endMs: number;
  total: number;
  perRequest: number;
};

type Band = { startMs: number; endMs: number; prefillCount: number };

type HoverState = {
  x: number;
  y: number;
  timeMs: number;
  rowIndex: number | null;
};

function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

function niceStep(span: number, divisions: number): number {
  const raw = span / Math.max(1, divisions);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (raw <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

function formatOffset(ms: number, step: number): string {
  if (step < 100) return `${Math.round(ms)}ms`;
  if (step < 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (step < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 1000).toFixed(0)}s`;
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function truncate(value: string): string {
  return value.length > MAX_LABEL_CHARS
    ? `${value.slice(0, MAX_LABEL_CHARS - 1)}…`
    : value;
}

function rowMetrics(count: number): { rowHeight: number; barHeight: number } {
  if (count > 40) return { rowHeight: 13, barHeight: 9 };
  if (count > 16) return { rowHeight: 17, barHeight: 11 };
  return { rowHeight: 22, barHeight: 13 };
}

function buildRows(requests: readonly BenchmarkRequestResult[]): RowShape[] {
  const totals = new Map<string, number>();
  for (const request of requests) {
    const key = `${request.topic}/${request.language}`;
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return requests.map((request) => {
    const key = `${request.topic}/${request.language}`;
    let label = key;
    if ((totals.get(key) ?? 0) > 1) {
      const index = (seen.get(key) ?? 0) + 1;
      seen.set(key, index);
      label = `${key} #${index}`;
    }
    return {
      request,
      label: truncate(label),
      submitMs: request.submitMs,
      prefillStartMs: request.prefillStartMs ?? request.submitMs,
      firstTokenMs: request.firstTokenMs,
      doneMs: request.doneMs,
      failed: request.error !== null,
    };
  });
}

function rowEndMs(row: RowShape): number {
  return row.doneMs ?? row.firstTokenMs ?? row.submitMs;
}

function mergeBands(segments: readonly BenchmarkSegment[]): Band[] {
  const bands: Band[] = [];
  for (const segment of segments) {
    if (segment.prefillCount === 0) continue;
    const last = bands.at(-1);
    if (last && Math.abs(last.endMs - segment.startMs) < 1e-6) {
      last.endMs = segment.endMs;
      last.prefillCount = Math.max(last.prefillCount, segment.prefillCount);
      continue;
    }
    bands.push({
      startMs: segment.startMs,
      endMs: segment.endMs,
      prefillCount: segment.prefillCount,
    });
  }
  return bands;
}

function buildRatePoints(segments: readonly BenchmarkSegment[]): RatePoint[] {
  const points: RatePoint[] = [];
  for (const segment of segments) {
    const rate = segment.decodeTokensPerSecond;
    if (segment.decodeCount === 0 || rate === null) continue;
    points.push({
      startMs: segment.startMs,
      endMs: segment.endMs,
      total: rate,
      perRequest: rate / segment.decodeCount,
    });
  }
  return points;
}

function stepPath(
  points: readonly RatePoint[],
  valueOf: (point: RatePoint) => number,
  x: (ms: number) => number,
  y: (value: number) => number,
): string {
  const parts: string[] = [];
  let previousEnd: number | null = null;
  for (const point of points) {
    const value = y(valueOf(point)).toFixed(1);
    const from = x(point.startMs).toFixed(1);
    const to = x(point.endMs).toFixed(1);
    if (previousEnd === null || Math.abs(previousEnd - point.startMs) > 1e-6) {
      parts.push(`M ${from} ${value}`);
    } else {
      parts.push(`L ${from} ${value}`);
    }
    parts.push(`L ${to} ${value}`);
    previousEnd = point.endMs;
  }
  return parts.join(" ");
}

function LegendSwatch(props: { color: string; label: string; line?: boolean }) {
  return (
    <Group gap={6} wrap="nowrap">
      <Box
        w={10}
        h={props.line ? 2 : 10}
        style={{ background: props.color, borderRadius: 2 }}
      />
      <Text size="xs" c="dimmed">
        {props.label}
      </Text>
    </Group>
  );
}

export function BenchmarkTimeline({ result }: { result: BenchmarkRunResult }) {
  const colorScheme = useComputedColorScheme("dark");
  const { ref, width } = useElementSize();
  const [hover, setHover] = useState<HoverState | null>(null);
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

  const waveRequests = result.requests.filter(
    (request) => request.repetition === activeRepetition,
  );
  const segments = result.segments.filter(
    (segment) => segment.repetition === activeRepetition,
  );
  const rows = buildRows(waveRequests).slice(0, MAX_ROWS);
  const hiddenRowCount = waveRequests.length - rows.length;

  const ratePoints = buildRatePoints(segments);
  const baseline = soloDecodeBaseline(result.segmentClasses);

  const prefillColor = metricToneColor("outbound", colorScheme);
  const decodeColor = metricToneColor("memory", colorScheme);
  const totalRateColor = metricToneColor("cpu", colorScheme);
  const perRequestRateColor = metricToneColor("gpuLoad", colorScheme);
  const queueColor = "var(--mantine-color-gray-6)";
  const errorColor = "var(--mantine-color-red-6)";
  const gridColor = "var(--mantine-color-default-border)";
  const dimmedColor = "var(--mantine-color-dimmed)";

  if (rows.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        No measurable requests in this repetition.
      </Text>
    );
  }

  const t0 = Math.min(...rows.map((row) => row.submitMs));
  const t1 = Math.max(...rows.map(rowEndMs), t0 + 1);
  const span = Math.max(1, t1 - t0);

  const { rowHeight, barHeight } = rowMetrics(rows.length);
  const longestLabel = rows.reduce(
    (longest, row) => Math.max(longest, row.label.length),
    0,
  );
  const gutter = Math.min(200, Math.max(76, longestLabel * 6 + 18));
  const plotWidth = Math.max(MIN_PLOT_WIDTH, width - gutter - RIGHT_GUTTER);
  const svgWidth = gutter + plotWidth + RIGHT_GUTTER;
  const rowsHeight = rows.length * rowHeight;
  const laneVisible = ratePoints.length > 1;
  const laneTop = ROWS_TOP + rowsHeight + LANE_GAP;
  const plotBottom = laneVisible
    ? laneTop + LANE_HEIGHT
    : ROWS_TOP + rowsHeight;
  const svgHeight = plotBottom + AXIS_HEIGHT;

  const x = (ms: number) => gutter + ((ms - t0) / span) * plotWidth;
  const scalePoints = ratePoints.filter(
    (point) => point.endMs - point.startMs >= BENCHMARK_CLASS_MIN_WALL_MS,
  );
  const laneMax = niceCeiling(
    Math.max(
      1,
      ...(scalePoints.length > 0 ? scalePoints : ratePoints).map(
        (point) => point.total,
      ),
      baseline ?? 0,
    ),
  );
  const laneY = (value: number) =>
    laneTop + LANE_HEIGHT - (Math.min(value, laneMax) / laneMax) * LANE_HEIGHT;

  const tickStep = niceStep(span, 6);
  const ticks: number[] = [];
  for (let value = 0; value <= span + tickStep * 0.001; value += tickStep) {
    ticks.push(value);
  }

  const bands = mergeBands(segments);
  const hoverSegment =
    hover === null
      ? null
      : (segments.find(
          (segment) =>
            hover.timeMs >= segment.startMs && hover.timeMs < segment.endMs,
        ) ?? null);
  const hoverRow =
    hover === null || hover.rowIndex === null
      ? null
      : (rows[hover.rowIndex] ?? null);

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    const pointerY = event.clientY - bounds.top;
    const ratio = (pointerX - gutter) / plotWidth;
    const rowIndex = Math.floor((pointerY - ROWS_TOP) / rowHeight);
    setHover({
      x: pointerX,
      y: pointerY,
      timeMs: t0 + Math.min(1, Math.max(0, ratio)) * span,
      rowIndex: rowIndex >= 0 && rowIndex < rows.length ? rowIndex : null,
    });
  };

  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="wrap">
        <Title order={4}>Timeline</Title>
        <Group gap="xs" wrap="wrap">
          <Text size="xs" c="dimmed">
            {hiddenRowCount > 0
              ? `${rows.length} of ${waveRequests.length} requests`
              : countLabel(rows.length, "request")}
          </Text>
          {repetitions.length > 1 &&
            (repetitions.length > WAVE_SELECT_THRESHOLD ? (
              <Select
                size="xs"
                w={130}
                allowDeselect={false}
                value={String(activeRepetition)}
                onChange={(value) => setRepetition(Number(value))}
                data={repetitions.map((value) => ({
                  value: String(value),
                  label: `Wave ${value + 1}`,
                }))}
              />
            ) : (
              <SegmentedControl
                size="xs"
                value={String(activeRepetition)}
                onChange={(value) => setRepetition(Number(value))}
                data={repetitions.map((value) => ({
                  value: String(value),
                  label: `Wave ${value + 1}`,
                }))}
              />
            ))}
        </Group>
      </Group>

      <Paper withBorder p="xs" radius="sm">
        <Box ref={ref} style={{ overflowX: "auto" }}>
          <Box pos="relative" style={{ width: svgWidth }}>
            {width > 0 && (
              <svg
                width={svgWidth}
                height={svgHeight}
                role="img"
                aria-label="Benchmark request timeline"
                style={{ display: "block", touchAction: "none" }}
                onPointerMove={handlePointerMove}
                onPointerLeave={() => setHover(null)}
              >
                {bands.map((band, index) => (
                  <g key={`band-${index}`}>
                    <rect
                      x={x(band.startMs)}
                      y={ROWS_TOP}
                      width={Math.max(1, x(band.endMs) - x(band.startMs))}
                      height={plotBottom - ROWS_TOP}
                      fill={prefillColor}
                      opacity={0.03 + 0.015 * Math.min(band.prefillCount, 4)}
                    />
                    <rect
                      x={x(band.startMs)}
                      y={BAND_MARK_TOP}
                      width={Math.max(1, x(band.endMs) - x(band.startMs))}
                      height={BAND_MARK_HEIGHT}
                      fill={prefillColor}
                      opacity={0.85}
                    />
                  </g>
                ))}

                {ticks.map((tick, index) => (
                  <g key={`tick-${index}`}>
                    <line
                      x1={x(t0 + tick)}
                      y1={ROWS_TOP}
                      x2={x(t0 + tick)}
                      y2={plotBottom}
                      stroke={gridColor}
                      strokeWidth={1}
                      shapeRendering="crispEdges"
                    />
                    <text
                      x={x(t0 + tick)}
                      y={plotBottom + 14}
                      textAnchor="middle"
                      fontSize={10}
                      fill={dimmedColor}
                    >
                      {formatOffset(tick, tickStep)}
                    </text>
                  </g>
                ))}

                <text
                  x={gutter + plotWidth + RIGHT_GUTTER - 58}
                  y={HEADER_BASELINE}
                  textAnchor="end"
                  fontSize={9}
                  fill={dimmedColor}
                >
                  TTFT
                </text>
                <text
                  x={gutter + plotWidth + RIGHT_GUTTER - 6}
                  y={HEADER_BASELINE}
                  textAnchor="end"
                  fontSize={9}
                  fill={dimmedColor}
                >
                  tok/s
                </text>

                {rows.map((row, index) => {
                  const top = ROWS_TOP + index * rowHeight;
                  const barTop = top + (rowHeight - barHeight) / 2;
                  const firstToken = row.firstTokenMs;
                  const done = row.doneMs;
                  const rate = row.request.clientDecodeTokensPerSecond;
                  const ttftMs =
                    firstToken === null ? null : firstToken - row.submitMs;
                  return (
                    <g key={row.request.requestId}>
                      {hover?.rowIndex === index && (
                        <rect
                          x={gutter}
                          y={top}
                          width={plotWidth}
                          height={rowHeight}
                          fill={dimmedColor}
                          opacity={0.08}
                        />
                      )}
                      <text
                        x={gutter - 8}
                        y={top + rowHeight / 2 + 3}
                        textAnchor="end"
                        fontSize={10}
                        fill={row.failed ? errorColor : dimmedColor}
                      >
                        {row.label}
                      </text>

                      {row.prefillStartMs > row.submitMs && (
                        <rect
                          x={x(row.submitMs)}
                          y={barTop + 3}
                          width={Math.max(
                            MIN_BAR_WIDTH,
                            x(row.prefillStartMs) - x(row.submitMs),
                          )}
                          height={barHeight - 6}
                          fill={queueColor}
                          opacity={0.7}
                        />
                      )}

                      {firstToken !== null && (
                        <rect
                          x={x(row.prefillStartMs)}
                          y={barTop}
                          width={Math.max(
                            MIN_BAR_WIDTH,
                            x(firstToken) - x(row.prefillStartMs),
                          )}
                          height={barHeight}
                          fill={prefillColor}
                        />
                      )}

                      {firstToken !== null && done !== null && (
                        <rect
                          x={x(firstToken)}
                          y={barTop}
                          width={Math.max(
                            MIN_BAR_WIDTH,
                            x(done) - x(firstToken),
                          )}
                          height={barHeight}
                          fill={decodeColor}
                          opacity={0.16}
                        />
                      )}

                      {firstToken !== null &&
                        done !== null &&
                        ratePoints
                          .filter(
                            (point) =>
                              point.endMs > firstToken && point.startMs < done,
                          )
                          .map((point, sliceIndex) => {
                            const from = Math.max(point.startMs, firstToken);
                            const to = Math.min(point.endMs, done);
                            const ratio =
                              baseline !== null && baseline > 0
                                ? point.perRequest / baseline
                                : 1;
                            return (
                              <rect
                                key={`slice-${sliceIndex}`}
                                x={x(from)}
                                y={barTop}
                                width={Math.max(MIN_BAR_WIDTH, x(to) - x(from))}
                                height={barHeight}
                                fill={decodeColor}
                                opacity={
                                  0.35 + 0.65 * Math.min(1, Math.max(0, ratio))
                                }
                              />
                            );
                          })}

                      {row.failed && (
                        <rect
                          x={x(rowEndMs(row))}
                          y={barTop}
                          width={MARKER_WIDTH}
                          height={barHeight}
                          fill={errorColor}
                        />
                      )}

                      <text
                        x={gutter + plotWidth + RIGHT_GUTTER - 58}
                        y={top + rowHeight / 2 + 3}
                        textAnchor="end"
                        fontSize={10}
                        fill={dimmedColor}
                      >
                        {ttftMs === null ? "—" : formatDuration(ttftMs)}
                      </text>
                      <text
                        x={gutter + plotWidth + RIGHT_GUTTER - 6}
                        y={top + rowHeight / 2 + 3}
                        textAnchor="end"
                        fontSize={10}
                        fill={dimmedColor}
                      >
                        {rate === null ? "—" : rate.toFixed(1)}
                      </text>
                    </g>
                  );
                })}

                {laneVisible && (
                  <g>
                    {[0.25, 0.5, 0.75].map((fraction) => (
                      <line
                        key={`lane-grid-${fraction}`}
                        x1={gutter}
                        y1={laneTop + LANE_HEIGHT * fraction}
                        x2={gutter + plotWidth}
                        y2={laneTop + LANE_HEIGHT * fraction}
                        stroke={gridColor}
                        strokeWidth={1}
                        shapeRendering="crispEdges"
                      />
                    ))}
                    <line
                      x1={gutter}
                      y1={laneTop + LANE_HEIGHT}
                      x2={gutter + plotWidth}
                      y2={laneTop + LANE_HEIGHT}
                      stroke={gridColor}
                      strokeWidth={1}
                      shapeRendering="crispEdges"
                    />
                    {baseline !== null && (
                      <>
                        <line
                          x1={gutter}
                          y1={laneY(baseline)}
                          x2={gutter + plotWidth}
                          y2={laneY(baseline)}
                          stroke={perRequestRateColor}
                          strokeWidth={1}
                          strokeDasharray="4 3"
                          opacity={0.7}
                        />
                        <text
                          x={gutter + plotWidth - 4}
                          y={laneY(baseline) - 3}
                          textAnchor="end"
                          fontSize={9}
                          fill={perRequestRateColor}
                        >
                          {`solo ${baseline.toFixed(1)}`}
                        </text>
                      </>
                    )}
                    <path
                      d={stepPath(ratePoints, (point) => point.total, x, laneY)}
                      stroke={totalRateColor}
                      strokeWidth={1.5}
                      fill="none"
                    />
                    <path
                      d={stepPath(
                        ratePoints,
                        (point) => point.perRequest,
                        x,
                        laneY,
                      )}
                      stroke={perRequestRateColor}
                      strokeWidth={2}
                      fill="none"
                    />
                    <text
                      x={gutter - 8}
                      y={laneTop + 9}
                      textAnchor="end"
                      fontSize={10}
                      fill={dimmedColor}
                    >
                      {`${laneMax} tok/s`}
                    </text>
                    <text
                      x={gutter - 8}
                      y={laneTop + LANE_HEIGHT}
                      textAnchor="end"
                      fontSize={10}
                      fill={dimmedColor}
                    >
                      0
                    </text>
                  </g>
                )}

                {hover !== null && (
                  <line
                    x1={x(hover.timeMs)}
                    y1={ROWS_TOP}
                    x2={x(hover.timeMs)}
                    y2={plotBottom}
                    stroke={dimmedColor}
                    strokeWidth={1}
                    shapeRendering="crispEdges"
                  />
                )}
              </svg>
            )}

            {hover !== null && (
              <Paper
                withBorder
                p={6}
                radius="sm"
                pos="absolute"
                top={Math.min(hover.y + 14, svgHeight - 96)}
                left={Math.max(
                  0,
                  Math.min(hover.x + 14, svgWidth - TOOLTIP_WIDTH),
                )}
                style={{ pointerEvents: "none", width: TOOLTIP_WIDTH }}
              >
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">
                    {`t = ${((hover.timeMs - t0) / 1000).toFixed(2)} s`}
                  </Text>
                  {hoverSegment && (
                    <>
                      <Text size="xs">
                        {`${hoverSegment.prefillCount} prefill · ${hoverSegment.decodeCount} decode`}
                      </Text>
                      {hoverSegment.decodeTokensPerSecond !== null &&
                        hoverSegment.decodeCount > 0 && (
                          <Text size="xs">
                            {`${hoverSegment.decodeTokensPerSecond.toFixed(1)} tok/s total · ${(
                              hoverSegment.decodeTokensPerSecond /
                              hoverSegment.decodeCount
                            ).toFixed(1)} per request`}
                          </Text>
                        )}
                    </>
                  )}
                  {hoverRow && (
                    <>
                      <Text size="xs" fw={600} mt={2}>
                        {hoverRow.label}
                      </Text>
                      {hoverRow.firstTokenMs !== null && (
                        <Text size="xs" c="dimmed">
                          {`prefill ${formatDuration(
                            hoverRow.firstTokenMs - hoverRow.prefillStartMs,
                          )} · ${hoverRow.request.promptTokens ?? "?"} prompt tokens`}
                        </Text>
                      )}
                      {hoverRow.firstTokenMs !== null &&
                        hoverRow.doneMs !== null && (
                          <Text size="xs" c="dimmed">
                            {`decode ${formatDuration(
                              hoverRow.doneMs - hoverRow.firstTokenMs,
                            )} · ${hoverRow.request.completionTokens ?? "?"} tokens`}
                          </Text>
                        )}
                      {hoverRow.request.error !== null && (
                        <Text size="xs" c="red">
                          {hoverRow.request.error}
                        </Text>
                      )}
                    </>
                  )}
                </Stack>
              </Paper>
            )}
          </Box>
        </Box>
      </Paper>

      <Group gap="md" wrap="wrap">
        <LegendSwatch color={queueColor} label="queue" />
        <LegendSwatch color={prefillColor} label="prefill" />
        <LegendSwatch color={decodeColor} label="decode" />
        {laneVisible && (
          <>
            <LegendSwatch color={totalRateColor} label="total tok/s" line />
            <LegendSwatch
              color={perRequestRateColor}
              label="per-request tok/s"
              line
            />
          </>
        )}
        <Text size="xs" c="dimmed">
          {baseline === null
            ? "shaded bands = a prefill is competing for batch capacity; no solo baseline in this run"
            : "pale decode = slower than the solo baseline; shaded bands = a prefill is competing for batch capacity"}
        </Text>
        {hiddenRowCount > 0 && (
          <Text size="xs" c="dimmed">
            {`${hiddenRowCount} more requests not drawn`}
          </Text>
        )}
      </Group>
    </Stack>
  );
}
