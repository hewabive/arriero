import type { ArgumentDefault, ArgumentOption } from "@arriero/core";
import {
  Code,
  EmptyState,
  Group,
  Paper,
  Stack,
  Table,
  Tooltip,
} from "@mantine/core";
import { Star } from "lucide-react";

import { useNarrowScreen } from "../hooks/use-narrow-screen";
import { defaultScopeLabel } from "./arguments-view-helpers";
import { type ArgumentsViewController } from "./use-arguments-view";

function ArgumentDefaultMarker(props: {
  defaults: ArgumentDefault[];
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
  const compact = useNarrowScreen();
  return (
    <Paper withBorder p="sm" radius="sm" className="args-reference-list">
      <Stack gap="sm">
        {compact ? (
          <Stack gap="xs">
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
                    defaults={fm.instanceDefaultsSection}
                    option={option}
                  />
                </Group>
              </Paper>
            ))}
            {fm.filteredOptions.length === 0 && (
              <Paper withBorder p="md" radius="sm">
                <EmptyState
                  size="sm"
                  title={
                    fm.argsCatalogQuery.isFetching
                      ? "Loading arguments..."
                      : "No matching arguments found"
                  }
                />
              </Paper>
            )}
          </Stack>
        ) : (
          <Table.ScrollContainer minWidth={220}>
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
                          defaults={fm.instanceDefaultsSection}
                          option={option}
                        />
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
                {fm.filteredOptions.length === 0 && (
                  <Table.Tr>
                    <Table.Td>
                      <EmptyState
                        size="sm"
                        title={
                          fm.argsCatalogQuery.isFetching
                            ? "Loading arguments..."
                            : "No matching arguments found"
                        }
                        py="lg"
                      />
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
