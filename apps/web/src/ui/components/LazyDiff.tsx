import { Button, Code, ScrollArea, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

export function LazyDiff({
  queryKey,
  queryFn,
}: {
  queryKey: unknown[];
  queryFn: () => Promise<{ data: { diff: string } }>;
}) {
  const [open, setOpen] = useState(false);
  const diffQuery = useQuery({
    queryKey,
    queryFn,
    enabled: open,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  return (
    <Stack gap="xs">
      <Button
        size="xs"
        variant="subtle"
        w="fit-content"
        loading={diffQuery.isFetching}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide diff" : "Show diff"}
      </Button>
      {open && diffQuery.data?.data.diff && (
        <ScrollArea.Autosize mah={420}>
          <Code block>{diffQuery.data.data.diff}</Code>
        </ScrollArea.Autosize>
      )}
      {open && diffQuery.isError && (
        <Text c="red" size="sm">
          Could not compute the diff: {(diffQuery.error as Error).message}
        </Text>
      )}
    </Stack>
  );
}
