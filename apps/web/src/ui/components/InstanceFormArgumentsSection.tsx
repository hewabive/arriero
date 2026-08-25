import {
  ActionIcon,
  Box,
  Button,
  Group,
  Stack,
  Switch,
  Text,
  Tooltip,
} from "@mantine/core";
import { Plus, RefreshCw } from "lucide-react";

import { ArgumentPicker } from "./ArgumentPicker";
import { ArgumentRow } from "./ArgumentRow";
import {
  type ArgRow,
  RawArgRow,
  canonicalOptionForRow,
  createArgRow,
  replaceCanonicalRow,
  valueTypeFromArgument,
} from "./InstanceArgumentRows";
import { type InstanceFormController } from "./use-instance-form";

export function InstanceFormArgumentsSection({
  fm,
}: {
  fm: InstanceFormController;
}) {
  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Text fw={600} size="sm">
          Arguments
        </Text>
        <Group gap="xs">
          <Switch
            size="sm"
            label="Deprecated"
            checked={fm.showDeprecatedArgs}
            onChange={(event) =>
              fm.setShowDeprecatedArgs(event.currentTarget.checked)
            }
          />
          <Switch
            size="sm"
            label="Raw view"
            checked={fm.showRawArgs}
            onChange={(event) => fm.setShowRawArgs(event.currentTarget.checked)}
          />
          <Button
            size="xs"
            variant="light"
            leftSection={<Plus size={14} />}
            onClick={() => fm.setArgRows((rows) => [...rows, createArgRow()])}
          >
            Add raw
          </Button>
        </Group>
      </Group>
      <Group align="flex-end" gap="xs" wrap="nowrap">
        <Box style={{ flex: 1 }}>
          <ArgumentPicker
            isError={fm.argsCatalogQuery.isError}
            isFetching={fm.argsCatalogQuery.isFetching}
            errorPlaceholder="Unable to read --help from this binary"
            data={fm.visibleKnownArgs.map((option) => {
              const aliases = option.names.filter(
                (name) => name !== option.primaryName,
              );
              const nameLabel = aliases.length
                ? `${option.primaryName}, ${aliases.join(", ")}`
                : option.primaryName;
              return {
                value: option.primaryName,
                label: `${nameLabel}${option.valueHint ? ` ${option.valueHint}` : ""} · ${option.category}${option.compatibility.presentInBinary ? "" : " · not in binary"}`,
                disabled: !option.compatibility.presentInBinary,
                searchTerms: [option.primaryName, ...option.names],
              };
            })}
            onPick={(value) => {
              const option = fm.knownArgByName.get(value);
              if (option) {
                fm.setArgRows((rows) => replaceCanonicalRow(rows, option));
              }
            }}
          />
        </Box>
        <Tooltip label={fm.argsCatalogTooltip} multiline maw={420} interactive>
          <ActionIcon
            aria-label="Reload arguments from binary help"
            variant="subtle"
            loading={
              fm.argsCatalogQuery.isFetching || fm.refreshArgsMutation.isPending
            }
            onClick={() => fm.refreshArgsMutation.mutate()}
          >
            <RefreshCw size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
      {fm.argsCatalogQuery.isError && (
        <Text c="red" size="xs">
          {(fm.argsCatalogQuery.error as Error).message}
        </Text>
      )}
      {fm.defaultOverlay.map((option) => (
        <ArgumentRow
          key={`default:${option.primaryName}`}
          keyLabel={option.primaryName}
          option={option}
          value={fm.defaultRowValue(option)}
          isDefault
          active={fm.defaultRowActive(option)}
          onToggle={(nextActive) => fm.setDefaultActive(option, nextActive)}
          onRemove={() => undefined}
          onValueChange={(value) => fm.setDefaultValue(option, value)}
        />
      ))}
      {fm.manualArgRows.length === 0 && (
        <Text c="dimmed" size="xs">
          No extra arguments. Host, port, model and router preset are configured
          above.
        </Text>
      )}
      {fm.manualArgRows.map((row, index) => {
        const option = canonicalOptionForRow(row, fm.knownArgByName);
        const onChange = (nextRow: ArgRow) =>
          fm.setArgRows((rows) =>
            rows.map((item) => (item.id === row.id ? nextRow : item)),
          );
        const onRemove = () =>
          fm.setArgRows((rows) => rows.filter((item) => item.id !== row.id));

        if (option && !fm.showRawArgs) {
          return (
            <ArgumentRow
              key={row.id}
              keyLabel={option.primaryName}
              option={option}
              value={row.value}
              isDefault={false}
              active
              onToggle={() => undefined}
              onRemove={onRemove}
              onValueChange={(value) =>
                onChange({
                  ...row,
                  key: option.primaryName,
                  value,
                  valueType: valueTypeFromArgument(option),
                })
              }
            />
          );
        }

        return (
          <RawArgRow
            key={row.id}
            row={row}
            index={index}
            canRemove
            onChange={onChange}
            onRemove={onRemove}
          />
        );
      })}
    </Stack>
  );
}
