import type { ApiProbeResult } from "@arriero/core";
import { Code, Paper, Stack, Text } from "@mantine/core";

import type { StreamProbeState } from "./types";
import { formatUnknown, responseOutput } from "./utils";

function probeResultText(result: ApiProbeResult) {
  return [
    "Result",
    `kind: ${result.kind}`,
    `endpoint: ${result.endpoint}`,
    `http_status: ${result.response.status ?? "offline"}`,
    `latency_ms: ${result.response.latencyMs}`,
    result.response.error ? `error: ${result.response.error}` : null,
    "",
    "Output",
    responseOutput(result),
    "",
    "Request body",
    formatUnknown(result.requestBody),
    "",
    "Response body",
    formatUnknown(result.response.body),
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function streamResultText(result: StreamProbeState) {
  return [
    "Stream",
    `status: ${result.status}`,
    result.endpoint ? `endpoint: ${result.endpoint}` : null,
    result.statusCode !== null ? `http_status: ${result.statusCode}` : null,
    result.latencyMs !== null ? `latency_ms: ${result.latencyMs}` : null,
    result.finishReason ? `finish_reason: ${result.finishReason}` : null,
    result.error ? `error: ${result.error}` : null,
    "",
    "Output",
    (result.error ?? result.text) ||
      (result.status === "streaming"
        ? "Waiting for tokens..."
        : "No streamed text received."),
    "",
    "Request body",
    formatUnknown(result.requestBody),
    "",
    "Metrics",
    formatUnknown({
      usage: result.usage,
      timings: result.timings,
      finishReason: result.finishReason,
    }),
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function ApiProbeResultView(props: { result: ApiProbeResult }) {
  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="xs">
        <Text fw={600} size="sm">
          Last probe output
        </Text>
        <Code block className="probe-output-text">
          {probeResultText(props.result)}
        </Code>
      </Stack>
    </Paper>
  );
}

export function StreamProbeResult(props: { result: StreamProbeState }) {
  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="xs">
        <Text fw={600} size="sm">
          Last stream output
        </Text>
        <Code block className="probe-output-text">
          {streamResultText(props.result)}
        </Code>
      </Stack>
    </Paper>
  );
}
