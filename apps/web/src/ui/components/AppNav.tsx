import { Badge, Box, Group, NavLink, Tooltip } from "@mantine/core";
import {
  Cpu,
  FlaskConical,
  Globe,
  HardDrive,
  LayoutDashboard,
  LockKeyhole,
  Server,
  Settings,
  Waypoints,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import {
  isLeafActive,
  type AppRoute,
  type NavLeaf,
  type NavSection,
} from "../routing";

export type NavSectionBadge = {
  count: number | null;
  dot: { tone: "error" | "warn"; label: string } | null;
};

const sectionIcons: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  instances: Server,
  proxy: Waypoints,
  files: HardDrive,
  engines: Wrench,
  host: Cpu,
  lab: FlaskConical,
  manager: Settings,
  "public-status": Globe,
  login: LockKeyhole,
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
  route: AppRoute;
  subpath: string;
  badges: Record<string, NavSectionBadge | undefined>;
  onNavigate: (leaf: NavLeaf) => void;
}) {
  return (
    <>
      {props.sections.map((section) => {
        const Icon = sectionIcons[section.id];
        const badge = props.badges[section.id];
        const active = section.items.some((leaf) =>
          isLeafActive(leaf, props.route, props.subpath),
        );
        return (
          <NavLink
            key={section.id}
            label={section.label}
            active={active}
            leftSection={Icon ? <Icon size={17} /> : null}
            rightSection={badge ? <SectionBadge badge={badge} /> : null}
            onClick={() => props.onNavigate(section.items[0]!)}
          />
        );
      })}
    </>
  );
}
