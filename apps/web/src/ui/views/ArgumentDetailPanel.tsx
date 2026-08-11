import type { ArgumentDefault, ArgumentOption } from "@arriero/core";
import {
  ActionIcon,
  Alert,
  Badge,
  Code,
  Divider,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Switch,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { AlertTriangle, Copy } from "lucide-react";

import { ArgumentValueControl } from "../components/ArgumentValueControl";
import { EngineeringMarkdown } from "../components/EngineeringMarkdown";
import { argumentDefaultFromOption } from "../utils/argument-defaults";
import {
  canUseAsInstanceDefault,
  defaultDraftKey,
  defaultNeedsValue,
  presetSupportColor,
  presetSupportLabel,
  sourceColor,
} from "./arguments-view-helpers";
import { type ArgumentsViewController } from "./use-arguments-view";

function ArgumentBadges(props: { option: ArgumentOption }) {
  return (
    <Group gap={6} wrap="wrap">
      <Badge variant="light">{props.option.category}</Badge>
      <Badge variant="outline">{props.option.valueType}</Badge>
      {props.option.valueHint && (
        <Badge
          className="argument-value-hint"
          title={props.option.valueHint}
          variant="outline"
        >
          {props.option.valueHint}
        </Badge>
      )}
      <Badge color={sourceColor(props.option.helpRuSource)} variant="outline">
        {props.option.helpRuSource}
      </Badge>
      {props.option.control.presetSupport !== "supported" && (
        <Badge
          color={presetSupportColor(props.option.control.presetSupport)}
          variant="light"
        >
          {presetSupportLabel(props.option.control.presetSupport)}
        </Badge>
      )}
      {props.option.deprecated && (
        <Badge color="red" variant="light">
          deprecated
        </Badge>
      )}
    </Group>
  );
}

function InstanceDefaultsCard({ fm }: { fm: ArgumentsViewController }) {
  const selectedOption = fm.selectedOption;
  if (!selectedOption) {
    return null;
  }
  const canUse = canUseAsInstanceDefault(selectedOption);
  const current = fm.selectedInstanceDefault;
  const enabled = Boolean(current);
  const suggested = argumentDefaultFromOption(selectedOption);
  const takesValue = defaultNeedsValue(suggested.valueType);
  const draftKey = defaultDraftKey(suggested.key);
  const draftValue =
    fm.defaultValueDrafts[draftKey] ?? current?.value ?? suggested.value;
  const commitOnChange =
    selectedOption.valueType === "boolean" ||
    (selectedOption.valueType === "enum" &&
      selectedOption.allowedValues.length > 0);

  function valueTypeFor(value: string): ArgumentDefault["valueType"] {
    if (!takesValue) {
      return suggested.valueType;
    }
    return value.trim() ? suggested.valueType : "null";
  }

  function commit(nextEnabled: boolean, value: string) {
    fm.saveInstanceDefault(nextEnabled, {
      value: value.trim(),
      valueType: valueTypeFor(value),
    });
  }

  function setDraftValue(nextValue: string) {
    fm.setDefaultValueDrafts((drafts) => ({
      ...drafts,
      [draftKey]: nextValue,
    }));
  }

  if (!canUse) {
    return fm.selectedDefaultUnavailableMessage ? (
      <Text c="dimmed" size="xs">
        {fm.selectedDefaultUnavailableMessage}
      </Text>
    ) : null;
  }

  return (
    <Group gap="sm" align="center" wrap="wrap">
      <Tooltip
        multiline
        w={250}
        withArrow
        label="Pins this argument in the New-instance form. Set a value to pre-fill it, or leave it empty to fill in per instance."
      >
        <Switch
          label="Pin to new instances"
          checked={enabled}
          disabled={fm.defaultsMutation.isPending}
          onChange={(event) => commit(event.currentTarget.checked, draftValue)}
        />
      </Tooltip>
      {enabled && takesValue && (
        <ArgumentValueControl
          key={selectedOption.primaryName}
          option={selectedOption}
          ariaLabel="Default value"
          value={draftValue}
          allowEmpty
          disabled={fm.defaultsMutation.isPending}
          size="xs"
          w={200}
          style={{ flex: "0 0 auto" }}
          onChange={(nextValue) => {
            setDraftValue(nextValue);
            if (commitOnChange) {
              commit(true, nextValue);
            }
          }}
          onBlur={(nextValue) => {
            if (!commitOnChange) {
              commit(true, nextValue);
            }
          }}
        />
      )}
    </Group>
  );
}

function curatedShortHelp(option: ArgumentOption): string | null {
  const { help, helpRu } = option;
  if (!helpRu || helpRu === help) {
    return null;
  }
  if (help && helpRu.endsWith(help)) {
    return null;
  }
  return helpRu;
}

export function ArgumentDetailPanel({ fm }: { fm: ArgumentsViewController }) {
  const selectedOption = fm.selectedOption;
  const shortHelp = selectedOption ? curatedShortHelp(selectedOption) : null;
  return (
    <Paper withBorder p="md" radius="sm" className="args-reference-detail">
      {selectedOption ? (
        <Stack gap="sm" className="args-detail-content">
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Group className="argument-name" gap={8} align="center" wrap="wrap">
              <Title order={4}>{selectedOption.primaryName}</Title>
              {selectedOption.names
                .filter((name) => name !== selectedOption.primaryName)
                .map((name) => (
                  <Code key={name}>{name}</Code>
                ))}
            </Group>
            <Tooltip label="Copy argument name">
              <ActionIcon
                aria-label="Copy argument name"
                variant="subtle"
                onClick={fm.copyArgumentName}
              >
                <Copy size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>

          <ArgumentBadges option={selectedOption} />

          {fm.supportsInstanceDefaults && <InstanceDefaultsCard fm={fm} />}

          {selectedOption.env.length > 0 && (
            <Stack gap={4}>
              <Text c="dimmed" size="xs">
                Environment
              </Text>
              <Group gap={6} wrap="wrap">
                {selectedOption.env.map((env) => (
                  <Code key={env}>{env}</Code>
                ))}
              </Group>
            </Stack>
          )}

          <details className="argument-secondary-details">
            <Text component="summary" fw={600} size="sm">
              Original --help and values
            </Text>
            <Stack gap="xs" mt="xs">
              {shortHelp && (
                <Text className="text-wrap" size="sm">
                  {shortHelp}
                </Text>
              )}

              {selectedOption.help && (
                <Text c="dimmed" className="text-wrap" size="sm">
                  {selectedOption.help}
                </Text>
              )}

              {selectedOption.allowedValues.length > 0 && (
                <Stack gap={4}>
                  <Text c="dimmed" size="xs">
                    Allowed values
                  </Text>
                  <Group gap={6} wrap="wrap">
                    {selectedOption.allowedValues.map((value) => (
                      <Code key={value}>{value}</Code>
                    ))}
                  </Group>
                </Stack>
              )}
            </Stack>
          </details>

          <Divider />

          <Stack gap="xs" className="args-detail-engineering">
            {fm.selectedDocQuery.isFetching && (
              <Text c="dimmed" size="sm">
                Loading engineering documentation...
              </Text>
            )}

            {fm.selectedDocQuery.isError && (
              <Alert
                color="red"
                icon={<AlertTriangle size={16} />}
                variant="light"
              >
                {(fm.selectedDocQuery.error as Error).message}
              </Alert>
            )}

            {fm.selectedDoc && fm.selectedDoc.exists ? (
              <ScrollArea
                className="args-eng-scroll"
                type="auto"
                offsetScrollbars
              >
                <EngineeringMarkdown markdown={fm.visibleEngineeringMarkdown} />
              </ScrollArea>
            ) : (
              <Paper withBorder p="sm" radius="sm">
                <Stack gap={4}>
                  <Text fw={600} size="sm">
                    Documentation file is missing
                  </Text>
                  <Text c="dimmed" size="sm">
                    Create this Markdown file and refresh the page. Agents can
                    work on it independently from the application code.
                  </Text>
                </Stack>
              </Paper>
            )}
          </Stack>
        </Stack>
      ) : (
        <Text c="dimmed" ta="center">
          Select an argument to view help
        </Text>
      )}
    </Paper>
  );
}
