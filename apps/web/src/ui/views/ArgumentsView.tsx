import {
  Alert,
  Badge,
  Group,
  Paper,
  Select,
  Stack,
  Switch,
  TextInput,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useEffect, useRef } from "react";

import { listEngineArgumentReferences } from "../../api/client";
import { TouchSelect } from "../components/TouchCombobox";
import { useHashSubpath } from "../routing";
import { countLabel } from "../utils/plural";
import { formatLocalDateTime } from "../utils/time";
import { ArgumentDetailPanel } from "./ArgumentDetailPanel";
import { ArgumentReferenceList } from "./ArgumentReferenceList";
import { SourceSyncPanel } from "./ArgumentSourceSyncPanel";
import { allFilterValue } from "./arguments-view-helpers";
import { useArgumentsView } from "./use-arguments-view";

function EngineReferenceSummary({ engineId }: { engineId: string }) {
  const queryClient = useQueryClient();
  const summariesQuery = useQuery({
    queryKey: ["engine-args-references"],
    queryFn: listEngineArgumentReferences,
    retry: false,
    refetchInterval: 60_000,
  });
  const summary = summariesQuery.data?.data.find(
    (item) => item.engineId === engineId,
  );
  const documented = summary?.documented ?? null;
  const lastDocumented = useRef<number | null>(null);

  useEffect(() => {
    if (documented === null) {
      return;
    }
    const previous = lastDocumented.current;
    lastDocumented.current = documented;
    if (previous === null || previous === documented) {
      return;
    }
    queryClient.invalidateQueries({
      queryKey: ["engine-args-reference", engineId],
    });
  }, [documented, engineId, queryClient]);

  if (!summary) {
    return null;
  }

  return (
    <Group gap="xs" wrap="wrap">
      {summary.entrypoint && (
        <Badge variant="outline">{summary.entrypoint}</Badge>
      )}
      {summary.total !== null && (
        <Badge variant="light">{countLabel(summary.total, "argument")}</Badge>
      )}
      <Badge color={summary.documented > 0 ? "teal" : "gray"} variant="light">
        {summary.documented} documented
      </Badge>
      {summary.commit && (
        <Badge color="gray" variant="outline">
          {summary.commit.slice(0, 12)}
        </Badge>
      )}
      {summary.updatedAt && (
        <Badge color="gray" variant="outline">
          reviewed {formatLocalDateTime(summary.updatedAt)}
        </Badge>
      )}
    </Group>
  );
}

export function ArgumentsView() {
  const [subpath] = useHashSubpath("args");
  const engineId = subpath.split("/")[0] || undefined;
  const fm = useArgumentsView(engineId);

  return (
    <Stack gap="md" className="args-view">
      {fm.argsCatalogQuery.isError && (
        <Alert color="red" icon={<AlertTriangle size={18} />} variant="light">
          {(fm.argsCatalogQuery.error as Error).message}
        </Alert>
      )}

      {fm.argsCatalog && fm.supportsInstanceDefaults && (
        <SourceSyncPanel
          report={fm.docsSyncQuery.data?.data}
          error={
            fm.docsSyncQuery.isError ? (fm.docsSyncQuery.error as Error) : null
          }
        />
      )}

      {engineId && (
        <EngineReferenceSummary key={engineId} engineId={engineId} />
      )}

      <Paper withBorder p="md" radius="sm">
        <Group justify="space-between" align="flex-end" wrap="wrap">
          <Group className="args-filter-controls" align="flex-end" gap="xs">
            <TextInput
              aria-label="Search arguments"
              label="Search"
              placeholder="name, category, help, env"
              value={fm.search}
              onChange={(event) => fm.setSearch(event.currentTarget.value)}
              className="search-input"
            />
            <TouchSelect
              aria-label="Argument category"
              label="Category"
              data={[
                { value: allFilterValue, label: "All categories" },
                ...fm.categories.map((item) => ({ value: item, label: item })),
              ]}
              value={fm.category}
              allowDeselect={false}
              searchable
              onChange={(value) => fm.setCategory(value ?? allFilterValue)}
              w={220}
            />
            <Select
              aria-label="Argument type"
              label="Type"
              data={[
                { value: allFilterValue, label: "All types" },
                ...fm.valueTypes.map((item) => ({ value: item, label: item })),
              ]}
              value={fm.valueType}
              allowDeselect={false}
              onChange={(value) => fm.setValueType(value ?? allFilterValue)}
              w={150}
            />
          </Group>
          <Group gap="lg" pb={4} wrap="wrap">
            <Switch
              label="Deprecated"
              checked={fm.showDeprecated}
              onChange={(event) =>
                fm.setShowDeprecated(event.currentTarget.checked)
              }
            />
            <Badge variant="light">
              {fm.filteredOptions.length}/{fm.options.length}
            </Badge>
          </Group>
        </Group>
      </Paper>

      <div className="args-reference-layout">
        <ArgumentReferenceList fm={fm} />
        <ArgumentDetailPanel fm={fm} />
      </div>
    </Stack>
  );
}
