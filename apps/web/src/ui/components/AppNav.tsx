import { Badge, Box, Group, NavLink, Tooltip } from "@mantine/core";

import type { NavLeaf, NavSection } from "../routing";

export type NavSectionBadge = {
  count: number | null;
  dot: { tone: "error" | "warn"; label: string } | null;
};

function SectionBadge(props: { badge: NavSectionBadge }) {
  const { count, dot } = props.badge;
  return (
    <Group gap={6} wrap="nowrap">
      {count !== null && count > 0 && (
        <Badge size="sm" variant="light" color="gray">
          {count}
        </Badge>
      )}
      {dot && (
        <Tooltip label={dot.label}>
          <Box
            w={8}
            h={8}
            bg={dot.tone === "error" ? "red.6" : "yellow.6"}
            style={{ borderRadius: "50%" }}
          />
        </Tooltip>
      )}
    </Group>
  );
}

export function AppNav(props: {
  sections: NavSection[];
  activeSectionId: string;
  badges?: Record<string, NavSectionBadge | undefined>;
  onNavigate: (leaf: NavLeaf) => void;
}) {
  return (
    <>
      {props.sections.map((section) => {
        const Icon = section.icon;
        const badge = props.badges?.[section.id];
        return (
          <NavLink
            key={section.id}
            label={section.label}
            active={section.id === props.activeSectionId}
            leftSection={<Icon size={17} />}
            rightSection={badge ? <SectionBadge badge={badge} /> : null}
            onClick={() => props.onNavigate(section.items[0]!)}
          />
        );
      })}
    </>
  );
}
