import type { HfGgufVariant } from "@arriero/core";
import { Badge, Checkbox, Group, Text } from "@mantine/core";

import { hfVariantTitle, type HfLocalVariantState } from "../utils/hf";
import { formatBytes } from "../utils/models";
import { countLabel } from "../utils/plural";
import { hfVariantKindBadge, hfVariantLocalBadge } from "./HfBadges";

export function HfVariantCheckbox(props: {
  variant: HfGgufVariant;
  state: HfLocalVariantState;
  selection: ReadonlySet<string>;
  onToggle: (paths: readonly string[], checked: boolean) => void;
}) {
  const { variant } = props;
  const checked = variant.paths.every((path) => props.selection.has(path));
  const indeterminate =
    !checked && variant.paths.some((path) => props.selection.has(path));
  return (
    <Checkbox
      checked={checked}
      indeterminate={indeterminate}
      onChange={(event) =>
        props.onToggle(variant.paths, event.currentTarget.checked)
      }
      label={
        <Group gap="xs" wrap="wrap">
          <Text size="sm" fw={500}>
            {hfVariantTitle(variant)}
          </Text>
          {hfVariantKindBadge(variant)}
          {hfVariantLocalBadge(props.state)}
          {variant.splitCount !== null && (
            <Badge color="gray" variant="outline">
              {countLabel(variant.paths.length, "shard")}
            </Badge>
          )}
          {!variant.complete && (
            <Badge color="red" variant="light">
              incomplete split
            </Badge>
          )}
          <Text size="sm" c="dimmed">
            {formatBytes(variant.totalBytes)}
          </Text>
        </Group>
      }
    />
  );
}
