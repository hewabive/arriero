import type { ArgumentOption } from "@arriero/core";
import {
  ActionIcon,
  Badge,
  Group,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { Trash2 } from "lucide-react";

import { ArgumentInfo } from "./ArgumentInfo";
import { ArgumentValueControl } from "./ArgumentValueControl";

export function ArgumentRow(props: {
  keyLabel: string;
  option: ArgumentOption | null;
  value: string;
  isDefault: boolean;
  active: boolean;
  onToggle: (active: boolean) => void;
  onRemove: () => void;
  onValueChange: (value: string) => void;
}) {
  const disabled = props.isDefault && !props.active;

  return (
    <Group gap="xs" wrap="wrap" align="center">
      {props.isDefault ? (
        <Tooltip
          label={props.active ? "Enabled" : "Default — off, not applied"}
        >
          <Switch
            aria-label={`${props.keyLabel} enabled`}
            checked={props.active}
            onChange={(event) => props.onToggle(event.currentTarget.checked)}
          />
        </Tooltip>
      ) : (
        <Tooltip label="Remove">
          <ActionIcon
            aria-label={`Remove ${props.keyLabel}`}
            variant="subtle"
            color="red"
            onClick={props.onRemove}
          >
            <Trash2 size={16} />
          </ActionIcon>
        </Tooltip>
      )}
      <Group gap={6} wrap="nowrap" w={210} style={{ flexShrink: 0 }}>
        <Text
          size="sm"
          ff="monospace"
          truncate
          {...(disabled ? { c: "dimmed" } : {})}
        >
          {props.keyLabel}
          {props.isDefault ? " · default" : ""}
        </Text>
        {props.option?.deprecated && (
          <Badge color="red" variant="outline" size="xs">
            deprecated
          </Badge>
        )}
      </Group>
      {props.option ? (
        <ArgumentValueControl
          option={props.option}
          value={props.value}
          disabled={disabled}
          onChange={props.onValueChange}
          style={{ flex: 1, minWidth: 150 }}
        />
      ) : (
        <TextInput
          aria-label={`${props.keyLabel} value`}
          value={props.value}
          disabled={disabled}
          onChange={(event) => props.onValueChange(event.currentTarget.value)}
          style={{ flex: 1, minWidth: 150 }}
          size="xs"
        />
      )}
      {props.option && <ArgumentInfo option={props.option} />}
    </Group>
  );
}
