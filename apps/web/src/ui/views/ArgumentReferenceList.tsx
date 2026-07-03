import type { ArgumentDefaults, ArgumentOption } from "@llama-manager/core";
import { Code, Group, Paper, Stack, Table, Text, Tooltip } from "@mantine/core";
import { Star } from "lucide-react";

import { defaultScopeLabel } from "./arguments-view-helpers";
import { type ArgumentsViewController } from "./use-arguments-view";

function ArgumentDefaultMarker(props: {
  defaults: ArgumentDefaults;
  option: ArgumentOption;
}) {
  const label = defaultScopeLabel(props.defaults, props.option);
  if (!label) {
    return null;
  }

  return (
    <Tooltip label={label}>
      <span className="argument-default-marker" aria-label={label}>
        <Star size={14} fill="currentColor" strokeWidth={2.4} />
      </span>
    </Tooltip>
  );
}

export function ArgumentReferenceList({ fm }: { fm: ArgumentsViewController }) {
  return (
    <Paper withBorder p="sm" radius="sm" className="args-reference-list">
      <Stack gap="sm">
        {fm.isMobileList ? (
          <Stack className="args-mobile-list" gap="xs">
            {fm.filteredOptions.map((option) => (
              <Paper
                key={option.primaryName}
                withBorder
                p="xs"
                radius="sm"
                className={
                  fm.selectedOption?.primaryName === option.primaryName
                    ? "mobile-card instance-card--selected"
                    : "mobile-card"
                }
                onClick={() => fm.selectArgument(option)}
              >
                <Group className="argument-list-entry" gap="xs" wrap="nowrap">
                  <Code className="argument-list-code">
                    {option.primaryName}
                  </Code>
                  <ArgumentDefaultMarker
                    defaults={fm.argumentDefaults}
                    option={option}
                  />
                </Group>
              </Paper>
            ))}
            {fm.filteredOptions.length === 0 && (
              <Paper withBorder p="md" radius="sm">
                <Text c="dimmed" ta="center">
                  {fm.argsCatalogQuery.isFetching
                    ? "Loading arguments..."
                    : "No matching arguments found"}
                </Text>
              </Paper>
            )}
          </Stack>
        ) : (
          <Table.ScrollContainer className="args-table" minWidth={220}>
            <Table striped highlightOnHover verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Argument</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {fm.filteredOptions.map((option) => (
                  <Table.Tr
                    key={option.primaryName}
                    className={
                      fm.selectedOption?.primaryName === option.primaryName
                        ? "argument-row selected-row"
                        : "argument-row"
                    }
                    onClick={() => fm.selectArgument(option)}
                  >
                    <Table.Td>
                      <Group
                        className="argument-list-entry"
                        gap="xs"
                        wrap="nowrap"
                      >
                        <Code className="argument-list-code">
                          {option.primaryName}
                        </Code>
                        <ArgumentDefaultMarker
                          defaults={fm.argumentDefaults}
                          option={option}
                        />
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
                {fm.filteredOptions.length === 0 && (
                  <Table.Tr>
                    <Table.Td>
                      <Text c="dimmed" ta="center" py="lg">
                        {fm.argsCatalogQuery.isFetching
                          ? "Loading arguments..."
                          : "No matching arguments found"}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Stack>
    </Paper>
  );
}
