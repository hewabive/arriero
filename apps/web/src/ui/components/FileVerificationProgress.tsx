import type { FileVerificationProgress as VerificationProgress } from "@arriero/core";
import { Group, Progress, Stack, Text } from "@mantine/core";
import { formatBytes, formatBytesPerSecond } from "../utils/models";
import { formatEtaSeconds } from "../utils/time";

export function FileVerificationProgress({
  progress,
}: {
  progress: VerificationProgress;
}) {
  const percent =
    progress.totalBytes > 0
      ? Math.min(100, (progress.processedBytes / progress.totalBytes) * 100)
      : 0;
  const remaining = Math.max(0, progress.totalBytes - progress.processedBytes);
  const eta =
    progress.bytesPerSecond && remaining > 0
      ? formatEtaSeconds(remaining / progress.bytesPerSecond)
      : null;
  return (
    <Stack gap={4}>
      <Group justify="space-between" gap="xs">
        <Text size="sm" fw={500}>
          Verifying file
        </Text>
        <Text size="sm" style={{ fontVariantNumeric: "tabular-nums" }}>
          {percent.toFixed(1)}%
        </Text>
      </Group>
      <Text size="xs" className="text-wrap">
        {progress.path}
      </Text>
      <Progress value={percent} size="sm" aria-label="File verification" />
      <Group justify="space-between" gap={4}>
        <Text size="xs" c="dimmed">
          {formatBytes(progress.processedBytes)} of{" "}
          {formatBytes(progress.totalBytes)} read
        </Text>
        <Text size="xs" c="dimmed">
          {progress.bytesPerSecond !== null
            ? formatBytesPerSecond(progress.bytesPerSecond)
            : "Measuring speed…"}
          {eta ? ` · ${eta} left for this file` : ""}
        </Text>
      </Group>
    </Stack>
  );
}
