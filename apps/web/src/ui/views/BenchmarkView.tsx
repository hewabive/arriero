import { SimpleGrid, Stack } from "@mantine/core";

import { BenchmarkPromptModal } from "./BenchmarkPromptModal";
import { BenchmarkRunDetail } from "./BenchmarkRunDetail";
import { BenchmarkRunForm } from "./BenchmarkRunForm";
import { BenchmarkRunsPanel } from "./BenchmarkRunsPanel";
import { useBenchmarkView } from "./use-benchmark-view";

export function BenchmarkView() {
  const fm = useBenchmarkView();
  return (
    <Stack gap="lg">
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <BenchmarkRunForm fm={fm} />
        <BenchmarkRunsPanel fm={fm} />
      </SimpleGrid>
      <BenchmarkRunDetail fm={fm} />
      <BenchmarkPromptModal fm={fm} />
    </Stack>
  );
}
