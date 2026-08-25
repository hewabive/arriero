import { Badge, Tooltip } from "@mantine/core";
import type { ReactNode } from "react";

export function DetailBadge({
  color,
  label,
  detail,
}: {
  color: string;
  label: ReactNode;
  detail: string | null | undefined;
}) {
  if (!detail) {
    return (
      <Badge color={color} variant="light">
        {label}
      </Badge>
    );
  }
  return (
    <Tooltip label={detail} multiline maw={420} withArrow interactive>
      <Badge color={color} variant="light" style={{ cursor: "help" }}>
        {label}
      </Badge>
    </Tooltip>
  );
}
