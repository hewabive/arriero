import {
  ApiProxyTraceCacheFilterSchema,
  type ApiProxyTraceCacheFilter,
  type ApiProxyTraceFacet,
  type ApiProxyTraceListQuery,
} from "@arriero/core";
import {
  Button,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { FilterX, History, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import {
  getApiProxyTraceFacets,
  listApiProxyTraceHistory,
} from "../../api/client";
import { formatTraceEndpoint, TracesTable } from "../proxy/TracesTable";

const PAGE_SIZE = 100;

const PERIOD_HOURS: Record<string, number> = {
  "1h": 1,
  "6h": 6,
  "24h": 24,
  "7d": 168,
  "30d": 720,
};

const PERIOD_OPTIONS = [
  { value: "all", label: "All history" },
  { value: "1h", label: "Last hour" },
  { value: "6h", label: "Last 6 hours" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "custom", label: "Custom range" },
];

type TraceFilterState = {
  period: string;
  customFrom: string;
  customTo: string;
  modelId: string | null;
  sourceId: string | null;
  targetId: string | null;
  endpoint: string | null;
  protocol: string | null;
  outcome: string | null;
  status: string | null;
  errorCode: string | null;
  cache: string | null;
  stream: string | null;
  resumed: string | null;
  translated: string | null;
  minDurationMs: number | string;
};

const CACHE_FILTER_LABELS: Record<ApiProxyTraceCacheFilter, string> = {
  hit: "Hit",
  coalesced: "Coalesced",
  store: "Store",
  none: "No cache",
};

const defaultFilters: TraceFilterState = {
  period: "all",
  customFrom: "",
  customTo: "",
  modelId: null,
  sourceId: null,
  targetId: null,
  endpoint: null,
  protocol: null,
  outcome: null,
  status: null,
  errorCode: null,
  cache: null,
  stream: null,
  resumed: null,
  translated: null,
  minDurationMs: "",
};

function localInputToIso(value: string): string | undefined {
  if (value === "") {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function buildHistoryQuery(filters: TraceFilterState): ApiProxyTraceListQuery {
  const query: ApiProxyTraceListQuery = { limit: PAGE_SIZE };
  if (filters.period === "custom") {
    const from = localInputToIso(filters.customFrom);
    const to = localInputToIso(filters.customTo);
    if (from) {
      query.from = from;
    }
    if (to) {
      query.to = to;
    }
  } else {
    const hours = PERIOD_HOURS[filters.period];
    if (hours !== undefined) {
      query.from = new Date(Date.now() - hours * 3_600_000).toISOString();
    }
  }
  if (filters.modelId) {
    query.modelId = filters.modelId;
  }
  if (filters.sourceId) {
    query.sourceId = filters.sourceId;
  }
  if (filters.targetId) {
    query.targetId = filters.targetId;
  }
  if (filters.endpoint) {
    query.endpoint = filters.endpoint;
  }
  if (filters.protocol) {
    query.protocol = filters.protocol;
  }
  if (filters.outcome === "ok") {
    query.ok = true;
  }
  if (filters.outcome === "error") {
    query.ok = false;
  }
  if (filters.status) {
    query.status = Number(filters.status);
  }
  if (filters.errorCode) {
    query.errorCode = filters.errorCode;
  }
  const cache = ApiProxyTraceCacheFilterSchema.safeParse(filters.cache);
  if (cache.success) {
    query.cache = cache.data;
  }
  if (filters.stream === "stream") {
    query.stream = true;
  }
  if (filters.stream === "single") {
    query.stream = false;
  }
  if (filters.resumed === "yes") {
    query.resumed = true;
  }
  if (filters.resumed === "no") {
    query.resumed = false;
  }
  if (filters.translated === "yes") {
    query.translated = true;
  }
  if (filters.translated === "no") {
    query.translated = false;
  }
  if (typeof filters.minDurationMs === "number" && filters.minDurationMs > 0) {
    query.minDurationMs = Math.floor(filters.minDurationMs);
  }
  return query;
}

function facetOptions(
  entries: ApiProxyTraceFacet[] | undefined,
  format?: (value: string) => string,
) {
  return (entries ?? []).map((entry) => ({
    value: entry.value,
    label: `${entry.name ?? format?.(entry.value) ?? entry.value} (${entry.count})`,
  }));
}

function FilterSelect(props: {
  label: string;
  value: string | null;
  data: Array<{ value: string; label: string }>;
  onChange: (value: string | null) => void;
  w?: number;
  searchable?: boolean;
}) {
  return (
    <Select
      size="xs"
      w={props.w ?? 170}
      label={props.label}
      placeholder="All"
      value={props.value}
      data={props.data}
      onChange={props.onChange}
      clearable
      searchable={props.searchable ?? false}
      nothingFoundMessage="Nothing found"
    />
  );
}

export function ProxyTracesView() {
  const [filters, setFilters] = useState<TraceFilterState>(defaultFilters);

  const update = (patch: Partial<TraceFilterState>) =>
    setFilters((prev) => ({ ...prev, ...patch }));

  const facetsQuery = useQuery({
    queryKey: ["api-proxy-trace-facets"],
    queryFn: getApiProxyTraceFacets,
  });
  const facets = facetsQuery.data?.data;

  const [debouncedFilters] = useDebouncedValue(filters, 300);

  const historyQuery = useInfiniteQuery({
    queryKey: ["api-proxy-trace-history", debouncedFilters],
    queryFn: ({ pageParam }) =>
      listApiProxyTraceHistory({
        ...buildHistoryQuery(debouncedFilters),
        ...(pageParam ? { before: pageParam } : { withTotal: true }),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.data.length < PAGE_SIZE
        ? null
        : (lastPage.data.at(-1)?.at ?? null),
  });

  const traces = useMemo(
    () => historyQuery.data?.pages.flatMap((page) => page.data) ?? [],
    [historyQuery.data],
  );
  const total = historyQuery.data?.pages[0]?.total ?? 0;
  const hasActiveFilters =
    JSON.stringify(filters) !== JSON.stringify(defaultFilters);

  const refresh = () => {
    void facetsQuery.refetch();
    void historyQuery.refetch();
  };

  return (
    <Stack gap="md">
      <Paper withBorder p="md" radius="sm">
        <Stack gap="sm">
          <Group justify="space-between" align="center" wrap="wrap">
            <Group gap="xs">
              <History size={18} />
              <Text fw={600}>Request history</Text>
              <Text c="dimmed" size="sm">
                {historyQuery.isLoading
                  ? "Loading…"
                  : `${traces.length} of ${total} shown${
                      facets ? ` · kept for ${facets.retentionDays} days` : ""
                    }`}
              </Text>
            </Group>
            <Group gap="xs">
              <Button
                size="compact-sm"
                variant="subtle"
                leftSection={<FilterX size={14} />}
                disabled={!hasActiveFilters}
                onClick={() => setFilters(defaultFilters)}
              >
                Reset filters
              </Button>
              <Button
                size="compact-sm"
                variant="light"
                leftSection={<RefreshCw size={14} />}
                loading={
                  historyQuery.isFetching && !historyQuery.isFetchingNextPage
                }
                onClick={refresh}
              >
                Refresh
              </Button>
            </Group>
          </Group>

          <Group gap="xs" align="flex-end" wrap="wrap">
            <Select
              size="xs"
              w={150}
              label="Period"
              value={filters.period}
              data={PERIOD_OPTIONS}
              onChange={(value) => update({ period: value ?? "all" })}
              allowDeselect={false}
            />
            {filters.period === "custom" && (
              <>
                <TextInput
                  size="xs"
                  w={190}
                  label="From"
                  type="datetime-local"
                  value={filters.customFrom}
                  onChange={(event) =>
                    update({ customFrom: event.currentTarget.value })
                  }
                />
                <TextInput
                  size="xs"
                  w={190}
                  label="To"
                  type="datetime-local"
                  value={filters.customTo}
                  onChange={(event) =>
                    update({ customTo: event.currentTarget.value })
                  }
                />
              </>
            )}
            <FilterSelect
              label="Model"
              value={filters.modelId}
              data={facetOptions(facets?.models)}
              onChange={(value) => update({ modelId: value })}
              w={200}
              searchable
            />
            <FilterSelect
              label="Source"
              value={filters.sourceId}
              data={facetOptions(facets?.sources)}
              onChange={(value) => update({ sourceId: value })}
              searchable
            />
            <FilterSelect
              label="Target"
              value={filters.targetId}
              data={facetOptions(facets?.targets)}
              onChange={(value) => update({ targetId: value })}
              searchable
            />
            <FilterSelect
              label="Endpoint"
              value={filters.endpoint}
              data={facetOptions(facets?.endpoints, formatTraceEndpoint)}
              onChange={(value) => update({ endpoint: value })}
              w={150}
            />
            <FilterSelect
              label="Protocol"
              value={filters.protocol}
              data={facetOptions(facets?.protocols)}
              onChange={(value) => update({ protocol: value })}
              w={130}
            />
            <FilterSelect
              label="Outcome"
              value={filters.outcome}
              data={[
                { value: "ok", label: "OK" },
                { value: "error", label: "Errors" },
              ]}
              onChange={(value) => update({ outcome: value })}
              w={110}
            />
            <FilterSelect
              label="Status"
              value={filters.status}
              data={facetOptions(facets?.statuses)}
              onChange={(value) => update({ status: value })}
              w={110}
            />
            <FilterSelect
              label="Error code"
              value={filters.errorCode}
              data={facetOptions(facets?.errorCodes)}
              onChange={(value) => update({ errorCode: value })}
              searchable
            />
            <FilterSelect
              label="Cache"
              value={filters.cache}
              data={Object.entries(CACHE_FILTER_LABELS).map(
                ([value, label]) => ({ value, label }),
              )}
              onChange={(value) => update({ cache: value })}
              w={120}
            />
            <FilterSelect
              label="Stream"
              value={filters.stream}
              data={[
                { value: "stream", label: "Stream" },
                { value: "single", label: "Single" },
              ]}
              onChange={(value) => update({ stream: value })}
              w={110}
            />
            <FilterSelect
              label="Resumed"
              value={filters.resumed}
              data={[
                { value: "yes", label: "Yes" },
                { value: "no", label: "No" },
              ]}
              onChange={(value) => update({ resumed: value })}
              w={100}
            />
            <FilterSelect
              label="Translated"
              value={filters.translated}
              data={[
                { value: "yes", label: "Yes" },
                { value: "no", label: "No" },
              ]}
              onChange={(value) => update({ translated: value })}
              w={100}
            />
            <NumberInput
              size="xs"
              w={130}
              label="Min duration ms"
              min={0}
              value={filters.minDurationMs}
              onChange={(value) => update({ minDurationMs: value })}
            />
          </Group>

          {historyQuery.isError && (
            <Text size="sm" c="red">
              {(historyQuery.error as Error).message}
            </Text>
          )}

          {!historyQuery.isLoading && traces.length === 0 && (
            <Text c="dimmed" size="sm">
              No traces match the current filters.
            </Text>
          )}

          {traces.length > 0 && <TracesTable traces={traces} />}

          {historyQuery.hasNextPage && (
            <Group justify="center">
              <Button
                variant="light"
                size="compact-sm"
                loading={historyQuery.isFetchingNextPage}
                onClick={() => void historyQuery.fetchNextPage()}
              >
                Load more
              </Button>
            </Group>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
