import { Tabs } from "@mantine/core";

import type { NavLeaf, NavSection } from "../routing";

function leafValue(leaf: NavLeaf): string {
  return `${leaf.route}:${leaf.subpath ?? ""}`;
}

export function SectionTabs(props: {
  section: NavSection;
  current: NavLeaf;
  onNavigate: (leaf: NavLeaf) => void;
}) {
  if (props.section.items.length < 2) {
    return null;
  }
  return (
    <Tabs
      value={leafValue(props.current)}
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
