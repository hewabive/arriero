import type {
  ApiProxyModelRecord,
  ApiProxyRouteExplainResult,
  ApiProxySourceRecord,
} from "@arriero/core";
import {
  Badge,
  Button,
  Code,
  Collapse,
  Group,
  Paper,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Textarea,
} from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { FlaskConical, Play } from "lucide-react";
import { useState } from "react";

import { explainApiProxyRoute } from "../../api/client";
import { TouchSelect } from "../components/TouchCombobox";
import { countLabel } from "../utils/plural";

type TestBenchProps = {
  models: ApiProxyModelRecord[];
  sources: ApiProxySourceRecord[];
  onResult?: (result: ApiProxyRouteExplainResult) => void;
};

const anonymousSourceValue = "__anonymous__";

function shortChatBody(modelId: string) {
  return JSON.stringify(
    {
      model: modelId,
      messages: [{ role: "user", content: "Hello! What can you do?" }],
    },
    null,
    2,
  );
}

function longChatBody(modelId: string) {
  return JSON.stringify(
    {
      model: modelId,
      messages: [
        {
          role: "user",
          content: `Summarize this document.\n${"Pretty long passage of plain text that stands in for real document content. ".repeat(400)}`,
        },
      ],
    },
    null,
    2,
  );
}

function explainStepLabel(
  step: ApiProxyRouteExplainResult["routeTrace"][number],
) {
  if (step.kind === "enter-pipeline") {
    return `▸ ${step.pipelineName ?? step.pipelineId ?? "?"}`;
  }
  return step.nodeName || step.nodeId || step.kind;
}

export function TestBench(props: TestBenchProps) {
  const [protocol, setProtocol] = useState<"openai" | "anthropic">("openai");
  const [modelId, setModelId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [bodyText, setBodyText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [showBody, setShowBody] = useState(false);

  const effectiveModelId =
    modelId ?? props.models.find((model) => model.enabled)?.modelId ?? "";

  const explainMutation = useMutation({
    mutationFn: explainApiProxyRoute,
    onSuccess: (response) => {
      props.onResult?.(response.data);
    },
  });
  const result = explainMutation.data?.data;

  function runExplain() {
    setParseError(null);
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch (error) {
      setParseError(`Body is not valid JSON: ${(error as Error).message}`);
      return;
    }
    explainMutation.mutate({
      protocol,
      body,
      sourceId: sourceId === anonymousSourceValue ? null : sourceId,
    });
  }

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Group justify="space-between" align="center" wrap="wrap">
          <Group gap="xs">
            <FlaskConical size={18} />
            <Text fw={600}>Route test bench</Text>
          </Group>
          <Text c="dimmed" size="sm">
            Dry-run a request body through the routing graph — nothing is
            forwarded, captured or counted.
          </Text>
        </Group>

        <Group align="flex-end" wrap="wrap">
          <SegmentedControl
            value={protocol}
            onChange={(value) => setProtocol(value as "openai" | "anthropic")}
            data={[
              { value: "openai", label: "OpenAI" },
              { value: "anthropic", label: "Anthropic" },
            ]}
          />
          <TouchSelect
            label="Model for presets"
            data={props.models.map((model) => ({
              value: model.modelId,
              label: model.modelId,
            }))}
            value={effectiveModelId || null}
            miw={220}
            searchable
            onChange={setModelId}
          />
          <TouchSelect
            label="Source"
            data={[
              { value: anonymousSourceValue, label: "Anonymous" },
              ...props.sources.map((source) => ({
                value: source.id,
                label: source.name,
              })),
            ]}
            value={sourceId ?? anonymousSourceValue}
            miw={180}
            onChange={setSourceId}
          />
          <Button
            variant="light"
            size="xs"
            disabled={!effectiveModelId}
            onClick={() => setBodyText(shortChatBody(effectiveModelId))}
          >
            Short chat
          </Button>
          <Button
            variant="light"
            size="xs"
            disabled={!effectiveModelId}
            onClick={() => setBodyText(longChatBody(effectiveModelId))}
          >
            Long chat
          </Button>
        </Group>

        <Textarea
          autosize
          minRows={4}
          maxRows={14}
          label="Request body"
          placeholder='{"model": "...", "messages": [...]}'
          value={bodyText}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setBodyText(value);
          }}
          error={parseError}
          styles={{ input: { fontFamily: "monospace" } }}
        />

        <Group>
          <Button
            leftSection={<Play size={16} />}
            loading={explainMutation.isPending}
            disabled={!bodyText.trim()}
            onClick={runExplain}
          >
            Explain route
          </Button>
          {explainMutation.isError && (
            <Text c="red" size="sm">
              {(explainMutation.error as Error).message}
            </Text>
          )}
        </Group>

        {result && (
          <Stack gap="xs">
            <Group gap="xs" wrap="wrap">
              <Badge color={result.ok ? "green" : "red"}>
                {result.ok ? "routed" : "failed"}
              </Badge>
              {result.targetName && (
                <Badge color="teal" variant="light">
                  target: {result.targetName}
                </Badge>
              )}
              {result.tokenEstimate !== null && (
                <Badge variant="light">~{result.tokenEstimate} tokens</Badge>
              )}
              {result.textReplacementCount > 0 && (
                <Badge variant="light">
                  {countLabel(result.textReplacementCount, "replacement")}
                </Badge>
              )}
            </Group>
            {result.diagnostic && (
              <Text c="red" size="sm">
                {result.diagnostic.code}: {result.diagnostic.message}
              </Text>
            )}
            {result.routeTrace.length > 0 && (
              <Table withTableBorder fz="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Step</Table.Th>
                    <Table.Th>Pipeline</Table.Th>
                    <Table.Th>Node</Table.Th>
                    <Table.Th>Port</Table.Th>
                    <Table.Th>Detail</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {result.routeTrace.map((step, index) => (
                    <Table.Tr key={index}>
                      <Table.Td>{step.kind}</Table.Td>
                      <Table.Td>{step.pipelineName ?? "—"}</Table.Td>
                      <Table.Td>
                        {step.kind === "enter-pipeline"
                          ? "—"
                          : explainStepLabel(step)}
                      </Table.Td>
                      <Table.Td>
                        {step.port ? <Code>{step.port}</Code> : "—"}
                      </Table.Td>
                      <Table.Td>{step.detail ?? "—"}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
            {result.ok && (
              <>
                <Button
                  variant="subtle"
                  size="xs"
                  onClick={() => setShowBody((value) => !value)}
                >
                  {showBody ? "Hide transformed body" : "Show transformed body"}
                </Button>
                <Collapse expanded={showBody}>
                  <Code block style={{ whiteSpace: "pre-wrap" }}>
                    {JSON.stringify(result.transformedBody, null, 2)}
                  </Code>
                </Collapse>
              </>
            )}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}
