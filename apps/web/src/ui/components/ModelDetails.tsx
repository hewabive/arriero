import { Badge, Flex, Group, Text, Tooltip } from "@mantine/core";

export type DetailRow = [string, string];

export type DetailSection = { title: string; rows: DetailRow[] };

export type DetailSectionBuilder = DetailSection & {
  push: (label: string, value: string | number | null | undefined) => void;
};

export function detailSection(title: string): DetailSectionBuilder {
  const rows: DetailRow[] = [];
  return {
    title,
    rows,
    push(label, value) {
      if (value !== null && value !== undefined && value !== "") {
        rows.push([label, String(value)]);
      }
    },
  };
}

export function pushKvHeadRows(
  section: DetailSectionBuilder,
  metadata: { headCount: number | null; headCountKv: number | null },
) {
  if (metadata.headCountKv !== null && metadata.headCount) {
    section.push(
      "KV heads (GQA)",
      `${metadata.headCountKv} (${Math.round(metadata.headCount / metadata.headCountKv)}:1)`,
    );
  } else {
    section.push("KV heads", metadata.headCountKv);
  }
}

export function pushExpertRows(
  section: DetailSectionBuilder,
  metadata: {
    expertCount: number | null;
    expertUsedCount: number | null;
    expertSharedCount: number | null;
    expertFeedForwardLength: number | null;
  },
) {
  section.push(
    "Experts (used/total)",
    metadata.expertCount !== null
      ? `${metadata.expertUsedCount ?? "?"}/${metadata.expertCount}`
      : null,
  );
  section.push("Shared experts", metadata.expertSharedCount);
  section.push("Expert FFN", metadata.expertFeedForwardLength);
}

export function DetailRows(props: { rows: DetailRow[] }) {
  return (
    <Flex wrap="wrap" rowGap={6} columnGap={24} maw="56rem">
      {props.rows.map(([label, value]) => (
        <Group key={label} gap={6} wrap="nowrap" align="baseline" maw="100%">
          <Text c="dimmed" size="xs" style={{ flexShrink: 0 }}>
            {label}
          </Text>
          <Text
            size="xs"
            style={{
              fontVariantNumeric: "tabular-nums",
              wordBreak: "break-word",
            }}
          >
            {value}
          </Text>
        </Group>
      ))}
    </Flex>
  );
}

export function FeatureBadge(props: {
  color: string;
  label: string;
  tooltip: string;
}) {
  return (
    <Tooltip label={props.tooltip}>
      <Badge
        color={props.color}
        variant="light"
        size="sm"
        style={{ flexShrink: 0 }}
      >
        {props.label}
      </Badge>
    </Tooltip>
  );
}

export function MoeTypeBadge(props: {
  isMoe: boolean;
  expertUsedCount: number | null;
  expertCount: number | null;
}) {
  if (!props.isMoe) {
    return (
      <Text c="dimmed" size="sm">
        dense
      </Text>
    );
  }
  return (
    <Tooltip
      label={`${props.expertUsedCount ?? "?"}/${props.expertCount} experts active`}
    >
      <Badge color="grape" variant="light">
        MoE
      </Badge>
    </Tooltip>
  );
}
