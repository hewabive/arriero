import type { ArgumentOption } from "@llama-manager/core";
import { ActionIcon, Badge, Button, Group, Popover, Text } from "@mantine/core";
import { ExternalLink, Info } from "lucide-react";

import { argumentHelpHref } from "../utils/argument-links";

export function ArgumentInfo(props: { option: ArgumentOption }) {
  const { option } = props;
  const canOpenEngineeringHelp = Boolean(option.doc.path);

  return (
    <Popover width={340} position="bottom-end" withArrow shadow="md">
      <Popover.Target>
        <ActionIcon
          aria-label={`${option.primaryName} help`}
          variant="subtle"
          color="gray"
        >
          <Info size={15} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Group gap="xs" mb={4}>
          <Badge variant="light" size="xs">
            {option.category}
          </Badge>
          <Badge variant="outline" size="xs">
            {option.valueType}
          </Badge>
          {!option.compatibility.presentInBinary && (
            <Badge color="red" variant="light" size="xs">
              not in binary
            </Badge>
          )}
        </Group>
        <Text size="sm">{option.helpRu}</Text>
        {option.allowedValues.length > 0 && (
          <Text c="dimmed" size="xs" mt={6}>
            Values: {option.allowedValues.join(", ")}
          </Text>
        )}
        <Text c="dimmed" size="xs" mt={6}>
          {option.names.join(", ")}
        </Text>
        {canOpenEngineeringHelp && (
          <Button
            component="a"
            href={argumentHelpHref(option.primaryName)}
            target="_blank"
            rel="noreferrer"
            variant="light"
            size="xs"
            mt="xs"
            leftSection={<ExternalLink size={14} />}
          >
            Engineering help
          </Button>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
