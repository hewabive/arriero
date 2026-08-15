import { Tabs } from "@mantine/core";

import {
  activeLeaf,
  type AppRoute,
  type NavLeaf,
  type NavSection,
} from "../routing";

function leafValue(leaf: NavLeaf): string {
  return `${leaf.route}:${leaf.subpath ?? ""}`;
}

export function SectionTabs(props: {
  section: NavSection;
  route: AppRoute;
  subpath: string;
  onNavigate: (leaf: NavLeaf) => void;
}) {
  if (props.section.items.length < 2) {
    return null;
  }
  const current = activeLeaf(props.route, props.subpath);
  return (
    <Tabs
      value={leafValue(current)}
      onChange={(value) => {
        const next = props.section.items.find(
          (leaf) => leafValue(leaf) === value,
        );
        if (next) {
          props.onNavigate(next);
        }
      }}
      className="section-tabs"
    >
      <Tabs.List>
        {props.section.items.map((leaf) => (
          <Tabs.Tab key={leafValue(leaf)} value={leafValue(leaf)}>
            {leaf.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs>
  );
}
