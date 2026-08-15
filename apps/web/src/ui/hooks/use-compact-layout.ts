import { useMediaQuery } from "@mantine/hooks";

const COMPACT_LAYOUT_QUERY = "(max-width: 64em)";

export function useCompactLayout(): boolean {
  return (
    useMediaQuery(COMPACT_LAYOUT_QUERY, false, {
      getInitialValueInEffect: false,
    }) ?? false
  );
}
