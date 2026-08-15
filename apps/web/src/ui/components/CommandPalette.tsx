import {
  Kbd,
  Modal,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { paletteSections, type NavLeaf } from "../routing";

type PaletteEntry = {
  leaf: NavLeaf;
  section: string;
  haystack: string;
};

const paletteEntries: PaletteEntry[] = paletteSections.flatMap((section) =>
  section.items.map((leaf) => ({
    leaf,
    section: section.label,
    haystack: [section.label, leaf.label, leaf.title, ...(leaf.keywords ?? [])]
      .join(" ")
      .toLowerCase(),
  })),
);

function rank(entry: PaletteEntry, query: string): number {
  const label = entry.leaf.label.toLowerCase();
  if (label.startsWith(query)) {
    return 3;
  }
  if (label.includes(query)) {
    return 2;
  }
  return entry.haystack.includes(query) ? 1 : 0;
}

export function CommandPalette(props: {
  opened: boolean;
  onOpenedChange: (opened: boolean) => void;
  onNavigate: (leaf: NavLeaf) => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const activeRef = useRef<HTMLAnchorElement | null>(null);
  const { opened, onOpenedChange } = props;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.code === "KeyK" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        onOpenedChange(!opened);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [opened, onOpenedChange]);

  useEffect(() => {
    if (opened) {
      setQuery("");
      setIndex(0);
    }
  }, [opened]);

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return paletteEntries;
    }
    return paletteEntries
      .map((entry) => ({ entry, score: rank(entry, normalized) }))
      .filter((scored) => scored.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((scored) => scored.entry);
  }, [query]);

  const safeIndex = Math.min(index, Math.max(results.length - 1, 0));

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [safeIndex, query]);

  function select(entry: PaletteEntry | undefined) {
    if (!entry) {
      return;
    }
    onOpenedChange(false);
    props.onNavigate(entry.leaf);
  }

  return (
    <Modal
      opened={opened}
      onClose={() => onOpenedChange(false)}
      withCloseButton={false}
      size="lg"
      padding="sm"
      yOffset="12vh"
    >
      <Stack gap="xs">
        <TextInput
          data-autofocus
          aria-label="Search pages"
          placeholder="Jump to a page — try logs, vram, cmake"
          leftSection={<Search size={16} />}
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex(Math.min(safeIndex + 1, results.length - 1));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex(Math.max(safeIndex - 1, 0));
            }
            if (event.key === "Enter") {
              event.preventDefault();
              select(results[safeIndex]);
            }
          }}
        />
        {results.length === 0 ? (
          <Text c="dimmed" size="sm" px="xs" py="md">
            Nothing matches “{query}”.
          </Text>
        ) : (
          <ScrollArea.Autosize mah={340} type="auto">
            <Stack gap={2}>
              {results.map((entry, position) => (
                <NavLink
                  key={`${entry.leaf.route}:${entry.leaf.subpath ?? ""}`}
                  ref={position === safeIndex ? activeRef : undefined}
                  active={position === safeIndex}
                  label={entry.leaf.label}
                  description={entry.section}
                  onMouseEnter={() => setIndex(position)}
                  onClick={() => select(entry)}
                />
              ))}
            </Stack>
          </ScrollArea.Autosize>
        )}
        <Text c="dimmed" size="xs" px="xs">
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> to move · <Kbd>Enter</Kbd> to open ·{" "}
          <Kbd>Esc</Kbd> to close
        </Text>
      </Stack>
    </Modal>
  );
}
