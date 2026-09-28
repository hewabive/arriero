import {
  benchmarkRequestEndMs,
  type BenchmarkLoadBucket,
  type BenchmarkRunResult,
} from "@arriero/core";
import {
  Box,
  Group,
  Pagination,
  Paper,
  Slider,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useMemo, useState } from "react";

import { countLabel } from "../utils/plural";
import { formatRate } from "./benchmark-format";
import { BenchmarkTimeline } from "./BenchmarkTimeline";

const PAGE_SIZE = 50;
const WIDTH = 900;
const LEFT = 55;
const RIGHT = 15;
const PLOT_WIDTH = WIDTH - LEFT - RIGHT;
const HEIGHT = 280;
const LANE_HEIGHT = 80;
const RATE_TOP = 25;
const CLIENT_TOP = 155;

function outputRate(bucket: BenchmarkLoadBucket): number | null {
  const duration = bucket.endMs - bucket.startMs;
  return duration > 0 && bucket.outputTokens !== null
    ? (bucket.outputTokens * 1000) / duration
    : null;
}

function interval(entry: BenchmarkLoadBucket): string {
  return `${(entry.startMs / 1000).toFixed(1)}–${(entry.endMs / 1000).toFixed(1)} s`;
}

function loadChart(buckets: readonly BenchmarkLoadBucket[]) {
  const duration = Math.max(1, buckets.at(-1)?.endMs ?? 1);
  const x = (ms: number) => LEFT + (ms * PLOT_WIDTH) / duration;
  const linePath = (
    values: (number | null)[],
    maximum: number,
    top: number,
  ) => {
    let path = "";
    let connected = false;
    for (const [index, value] of values.entries()) {
      const bucket = buckets[index];
      if (value === null || !bucket) {
        connected = false;
        continue;
      }
      const y = top + LANE_HEIGHT * (1 - value / maximum);
      path += `${connected ? "L" : "M"}${x(bucket.startMs)},${y} L${x(bucket.endMs)},${y} `;
      connected = true;
    }
    return path;
  };
  const rates = buckets.map(outputRate);
  const rateMax = Math.max(1, ...rates.map((value) => value ?? 0));
  const clientMax = Math.max(
    1,
    ...buckets.map((value) => value.averageActiveRequests),
  );
  return {
    x,
    lanes: [
      { top: RATE_TOP, max: rateMax, label: "Successful output · tok/s" },
      { top: CLIENT_TOP, max: clientMax, label: "Average concurrent requests" },
    ],
    series: [
      {
        color: "teal",
        label: "Output tok/s",
        path: linePath(rates, rateMax, RATE_TOP),
      },
      {
        color: "blue",
        label: "In flight",
        path: linePath(
          buckets.map((entry) => entry.averageActiveRequests),
          clientMax,
          CLIENT_TOP,
        ),
      },
      {
        color: "orange",
        label: "Awaiting first output, including queueing",
        path: linePath(
          buckets.map((entry) => entry.averageWaitingRequests),
          clientMax,
          CLIENT_TOP,
        ),
      },
    ],
    targets: buckets.map((entry) => ({
      x: x(entry.startMs),
      width: Math.max(1, x(entry.endMs) - x(entry.startMs)),
      title: `${interval(entry)} · ${formatRate(outputRate(entry))} tok/s · ${entry.completedRequests} completed · ${entry.failedRequests} failed`,
    })),
  };
}

export function BenchmarkLoadTimeline({
  result,
}: {
  result: BenchmarkRunResult;
}) {
  const buckets = useMemo(() => result.loadTimeline ?? [], [result]);
  const chart = useMemo(() => loadChart(buckets), [buckets]);
  const [selected, setSelected] = useState(0);
  const [page, setPage] = useState(1);
  const activeIndex = Math.min(selected, Math.max(0, buckets.length - 1));
  const bucket = buckets[activeIndex];
  const requests = useMemo(
    () =>
      bucket
        ? result.requests.filter(
            (request) =>
              request.submitMs <= bucket.endMs &&
              benchmarkRequestEndMs(request) >= bucket.startMs,
          )
        : [],
    [bucket, result],
  );
  const pages = Math.max(1, Math.ceil(requests.length / PAGE_SIZE));
  const activePage = Math.min(page, pages);
  const detail = useMemo(
    () => ({
      requests: requests.slice(
        (activePage - 1) * PAGE_SIZE,
        activePage * PAGE_SIZE,
      ),
      segments: [],
    }),
    [requests, activePage],
  );
  if (!bucket) return null;
  const { x } = chart;
  const select = (index: number) => {
    setSelected(index);
    setPage(1);
  };

  return (
    <Stack gap="sm">
      <Title order={4}>Load over time</Title>
      <Paper withBorder p="sm" radius="sm">
        <Stack gap="xs">
          <Box style={{ overflowX: "auto" }}>
            <svg
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              style={{ display: "block", width: "100%", minWidth: 480 }}
              role="img"
              aria-label="Sustained benchmark throughput and concurrent requests"
            >
              <rect
                x={x(bucket.startMs)}
                y={RATE_TOP}
                width={Math.max(1, x(bucket.endMs) - x(bucket.startMs))}
                height={CLIENT_TOP + LANE_HEIGHT - RATE_TOP}
                fill="var(--mantine-color-blue-5)"
                opacity={0.16}
              />
              {chart.lanes.map((lane) => (
                <g key={lane.top}>
                  <text
                    x={LEFT}
                    y={lane.top - 10}
                    fill="var(--mantine-color-text)"
                    fontSize={12}
                  >
                    {lane.label}
                  </text>
                  {[0, 0.5, 1].map((fraction) => (
                    <g key={fraction}>
                      <line
                        x1={LEFT}
                        x2={WIDTH - RIGHT}
                        y1={lane.top + LANE_HEIGHT * fraction}
                        y2={lane.top + LANE_HEIGHT * fraction}
                        stroke="var(--mantine-color-dimmed)"
                        opacity={0.2}
                      />
                      <text
                        x={LEFT - 8}
                        y={lane.top + LANE_HEIGHT * fraction + 4}
                        textAnchor="end"
                        fill="var(--mantine-color-dimmed)"
                        fontSize={11}
                      >
                        {formatRate(lane.max * (1 - fraction))}
                      </text>
                    </g>
                  ))}
                </g>
              ))}
              {chart.series.map((series) => (
                <path
                  key={series.color}
                  d={series.path}
                  fill="none"
                  stroke={`var(--mantine-color-${series.color}-5)`}
                  strokeWidth={2}
                />
              ))}
              {chart.targets.map((target, index) => (
                <rect
                  key={index}
                  x={target.x}
                  y={RATE_TOP}
                  width={target.width}
                  height={CLIENT_TOP + LANE_HEIGHT - RATE_TOP}
                  fill="transparent"
                  style={{ cursor: "pointer" }}
                  onClick={() => select(index)}
                >
                  <title>{target.title}</title>
                </rect>
              ))}
              {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
                <text
                  key={fraction}
                  x={LEFT + fraction * PLOT_WIDTH}
                  y={HEIGHT - 18}
                  textAnchor={
                    fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"
                  }
                  fill="var(--mantine-color-dimmed)"
                  fontSize={11}
                >
                  {(((buckets.at(-1)?.endMs ?? 0) * fraction) / 1000).toFixed(
                    1,
                  )}{" "}
                  s
                </text>
              ))}
            </svg>
          </Box>
          <Group gap="md" wrap="wrap">
            {chart.series.map((series) => (
              <Text key={series.color} size="xs" c={series.color}>
                {series.label}
              </Text>
            ))}
          </Group>
          {buckets.length > 1 && (
            <Slider
              thumbLabel="Inspect time interval"
              min={0}
              max={buckets.length - 1}
              step={1}
              value={activeIndex}
              onChange={select}
              label={(value) =>
                buckets[value] ? interval(buckets[value]) : ""
              }
              mt="xs"
            />
          )}
          <Text size="sm">
            {interval(bucket)} · {formatRate(outputRate(bucket))} tok/s ·{" "}
            {countLabel(bucket.completedRequests, "completed request")} ·{" "}
            {bucket.failedRequests} failed
          </Text>
        </Stack>
      </Paper>
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {countLabel(requests.length, "request")} overlapping the selected
          interval
        </Text>
        {pages > 1 && (
          <Pagination
            total={pages}
            value={activePage}
            onChange={setPage}
            size="sm"
            siblings={1}
          />
        )}
      </Group>
      {requests.length > 0 ? (
        <BenchmarkTimeline
          result={detail}
          baseline={null}
          caption="Request averages; queueing and prefill are combined when server timings are unavailable."
        />
      ) : (
        <Text size="sm" c="dimmed">
          No requests in this interval.
        </Text>
      )}
    </Stack>
  );
}
