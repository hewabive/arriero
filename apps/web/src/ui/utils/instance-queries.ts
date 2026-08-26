import type { QueryClient } from "@tanstack/react-query";

const GLOBAL_QUERY_KEYS = [
  ["instances"],
  ["instances-health-summary"],
  ["instance-resource-profiles"],
];

const INSTANCE_QUERY_KEYS = [
  "instance-health-summary",
  "instance-runtime",
  "instance-llama",
  "instance-llama-capabilities",
  "instance-status-summary",
  "instance-logs",
];

export async function invalidateInstanceQueries(
  queryClient: QueryClient,
  name: string,
): Promise<void> {
  await Promise.all([
    ...GLOBAL_QUERY_KEYS.map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
    ...INSTANCE_QUERY_KEYS.map((key) =>
      queryClient.invalidateQueries({ queryKey: [key, name] }),
    ),
  ]);
}
