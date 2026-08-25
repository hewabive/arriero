import { Badge, Group, Tooltip } from "@mantine/core";
import { Workflow } from "lucide-react";
import { Fragment } from "react";

import type { ProxyUsageRef } from "../usage";

function usageRefTooltip(ref: ProxyUsageRef): string | null {
  const parts: string[] = [];
  if (ref.via.length > 0) {
    parts.push(`via ${ref.via.join(", ")}`);
  }
  if (!ref.enabled) {
    parts.push("referrer disabled");
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function UsedByCell(props: { refs: ProxyUsageRef[] | undefined }) {
  const refs = props.refs ?? [];
  if (refs.length === 0) {
    return (
      <Badge color="gray" variant="outline">
        unused
      </Badge>
    );
  }
  return (
    <Group gap={4} wrap="wrap">
      {refs.map((ref) => {
        const tooltip = usageRefTooltip(ref);
        const badge =
          ref.kind === "pipeline" ? (
            <Badge
              variant="light"
              color={ref.enabled ? "teal" : "gray"}
              component="a"
              href={`#/routing/${ref.id}`}
              style={{ cursor: "pointer" }}
              leftSection={<Workflow size={10} />}
            >
              {ref.label}
            </Badge>
          ) : (
            <Badge variant="light" color={ref.enabled ? "blue" : "gray"}>
              {ref.label}
            </Badge>
          );
        return (
          <Fragment key={`${ref.kind}-${ref.id}`}>
            {tooltip ? (
              <Tooltip label={tooltip} multiline maw={360} interactive>
                {badge}
              </Tooltip>
            ) : (
              badge
            )}
          </Fragment>
        );
      })}
    </Group>
  );
}
