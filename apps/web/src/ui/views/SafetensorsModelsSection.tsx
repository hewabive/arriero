import type { SafetensorsModel } from "@arriero/core";
import {
  ActionIcon,
  Badge,
  Button,
  Collapse,
  Divider,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import {
  DetailRows,
  detailSection,
  FeatureBadge,
  MoeTypeBadge,
  pushExpertRows,
  pushKvHeadRows,
  type DetailSection,
} from "../components/ModelDetails";
import {
  compareSafetensorsTitles,
  formatBytes,
  formatParameterCount,
  ropeScalingLabel,
  safetensorsMatchesSearch,
  samplingSummary,
} from "../utils/models";
import { countLabel } from "../utils/plural";

function safetensorsMetaSections(model: SafetensorsModel): DetailSection[] {
  const m = model.metadata;

  const overview = detailSection("Overview");
  overview.push("Kind", m.kind !== "model" ? m.kind : null);
  overview.push("Architecture", m.architecture);
  overview.push("Model type", m.modelType);
  overview.push("Base model", m.baseModel);
  overview.push("Parameters", formatParameterCount(m.parameterCount));
  overview.push("Tensors", m.tensorCount);
  overview.push("Torch dtype", m.torchDtype);
  overview.push("Quantization", m.quantization);
  overview.push("Size on disk", formatBytes(model.sizeBytes));
  if (m.elementsByDtype.length > 1) {
    overview.push(
      "Dtype split",
      m.elementsByDtype
        .map(
          ([dtype, elements]) =>
            `${dtype} ${formatParameterCount(elements) ?? elements}`,
        )
        .join(", "),
    );
  }

  const arch = detailSection("Architecture");
  arch.push("Layers", m.blockCount);
  if (m.expertCount !== null && m.expertCount > 1) {
    pushExpertRows(arch, m);
  }
  arch.push("FFN length", m.feedForwardLength);
  arch.push("Embedding length", m.embeddingLength);
  arch.push("Attention heads", m.headCount);
  pushKvHeadRows(arch, m);
  arch.push("Head dim", m.headDim);
  arch.push("Vision tower", formatParameterCount(m.visionParameterCount));
  arch.push("MTP head", formatParameterCount(m.mtpParameterCount));
  arch.push("Context (train)", m.contextLength);
  arch.push("Sliding window", m.slidingWindow);
  arch.push("RoPE freq base", m.ropeFreqBase);
  arch.push("RoPE scaling", ropeScalingLabel(m));
  arch.push("RoPE orig ctx", m.ropeScalingOrigCtxLen);
  arch.push(
    "Tied embeddings",
    m.tieWordEmbeddings === null ? null : m.tieWordEmbeddings ? "yes" : "no",
  );

  const tokenizer = detailSection("Tokenizer");
  tokenizer.push("Vocab size", m.vocabularySize);
  tokenizer.push("Chat template", m.hasChatTemplate ? "yes" : null);

  const provenance = detailSection("Provenance");
  provenance.push("Transformers", m.transformersVersion);
  provenance.push("Rec. sampling", samplingSummary(m));

  const files = detailSection("Files");
  files.push("Weight files", model.weightFiles.join(", ") || null);
  files.push("Missing shards", model.missingShardNames.join(", ") || null);

  return [overview, arch, tokenizer, provenance, files];
}

function safetensorsParamsLabel(model: SafetensorsModel) {
  return formatParameterCount(model.metadata.parameterCount) ?? "-";
}

function KindBadge(props: { model: SafetensorsModel }) {
  const kind = props.model.metadata.kind;
  if (kind === "model") {
    return null;
  }
  return (
    <FeatureBadge
      color={kind === "adapter" ? "orange" : "gray"}
      label={kind}
      tooltip={
        kind === "adapter"
          ? "LoRA/PEFT adapter (adapter_config.json, no config.json)"
          : "Weights without a config.json"
      }
    />
  );
}

function SafetensorsTypeBadge(props: { model: SafetensorsModel }) {
  const m = props.model.metadata;
  return (
    <MoeTypeBadge
      isMoe={m.expertCount !== null && m.expertCount > 1}
      expertUsedCount={m.expertUsedCount}
      expertCount={m.expertCount}
    />
  );
}

function SafetensorsMtpBadge(props: { model: SafetensorsModel }) {
  const mtpParams = props.model.metadata.mtpParameterCount;
  if (!mtpParams) {
    return null;
  }
  return (
    <FeatureBadge
      color="cyan"
      label="MTP"
      tooltip={`Built-in speculative-decoding head (NextN/MTP), ${formatParameterCount(mtpParams)} params`}
    />
  );
}

function SafetensorsVisionBadge(props: { model: SafetensorsModel }) {
  const visionParams = props.model.metadata.visionParameterCount;
  if (!visionParams) {
    return null;
  }
  return (
    <FeatureBadge
      color="indigo"
      label="vision"
      tooltip={`Built-in vision tower, ${formatParameterCount(visionParams)} params`}
    />
  );
}

function SafetensorsDetailPanel(props: { model: SafetensorsModel }) {
  const sections = safetensorsMetaSections(props.model);
  return (
    <Stack gap="sm">
      {sections.map((section) =>
        section.rows.length === 0 ? null : (
          <Stack key={section.title} gap={6}>
            <Divider label={section.title} labelPosition="left" />
            <DetailRows rows={section.rows} />
          </Stack>
        ),
      )}
      <Text c="dimmed" size="xs" className="text-wrap">
        {props.model.path}
      </Text>
    </Stack>
  );
}

export function SafetensorsModelsSection(props: {
  models: SafetensorsModel[];
  search: string;
  compact: boolean;
  onUseModel: (model: SafetensorsModel) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpanded(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  const models = useMemo(
    () => [...props.models].sort(compareSafetensorsTitles),
    [props.models],
  );
  const filtered = useMemo(
    () =>
      models.filter((model) => safetensorsMatchesSearch(model, props.search)),
    [models, props.search],
  );

  if (models.length === 0) {
    return null;
  }

  return (
    <Stack gap="xs">
      <Group gap="xs" align="center">
        <Text fw={600} size="sm">
          Safetensors models
        </Text>
        <Badge variant="light">
          {filtered.length}/{models.length}
        </Badge>
      </Group>

      {props.compact && (
        <Stack gap="xs">
          {filtered.map((model) => {
            const isOpen = expanded.has(model.path);
            return (
              <Paper key={model.path} withBorder p="sm" radius="sm">
                <Stack gap="xs">
                  <div>
                    <Text fw={600} size="sm">
                      {model.name}
                    </Text>
                    <Text c="dimmed" size="xs" className="text-wrap">
                      {model.path}
                    </Text>
                    {model.error && (
                      <Text c="red" size="xs">
                        {model.error}
                      </Text>
                    )}
                  </div>
                  <Group gap="xs">
                    <Badge variant="light">
                      {model.metadata.modelType ??
                        model.metadata.architecture ??
                        "unknown arch"}
                    </Badge>
                    <SafetensorsTypeBadge model={model} />
                    <SafetensorsMtpBadge model={model} />
                    <SafetensorsVisionBadge model={model} />
                    <KindBadge model={model} />
                    <Badge variant="outline">
                      {safetensorsParamsLabel(model)}
                    </Badge>
                    <Badge variant="outline">
                      {model.metadata.quantization ?? "unknown dtype"}
                    </Badge>
                    <Badge variant="outline">
                      {formatBytes(model.sizeBytes)}
                    </Badge>
                    <Badge variant="outline">
                      ctx {model.metadata.contextLength ?? "-"}
                    </Badge>
                  </Group>
                  <Collapse in={isOpen}>
                    {isOpen && <SafetensorsDetailPanel model={model} />}
                  </Collapse>
                  <Group gap="xs">
                    <Button
                      size="xs"
                      variant="subtle"
                      onClick={() => toggleExpanded(model.path)}
                    >
                      {isOpen ? "Hide details" : "Details"}
                    </Button>
                    <Button
                      size="xs"
                      variant="light"
                      disabled={model.metadata.kind !== "model"}
                      onClick={() => props.onUseModel(model)}
                    >
                      Use in new
                    </Button>
                  </Group>
                </Stack>
              </Paper>
            );
          })}
          {filtered.length === 0 && (
            <Paper withBorder p="md" radius="sm">
              <Text c="dimmed" ta="center">
                No matching safetensors models
              </Text>
            </Paper>
          )}
        </Stack>
      )}

      {!props.compact && (
        <Table.ScrollContainer minWidth={1120}>
          <Table striped highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={36} />
                <Table.Th>Model</Table.Th>
                <Table.Th>Arch</Table.Th>
                <Table.Th w={160}>Type</Table.Th>
                <Table.Th>Params</Table.Th>
                <Table.Th>Layers</Table.Th>
                <Table.Th>Ctx</Table.Th>
                <Table.Th>Dtype</Table.Th>
                <Table.Th>Size</Table.Th>
                <Table.Th>Files</Table.Th>
                <Table.Th ta="right">Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {filtered.map((model) => {
                const isOpen = expanded.has(model.path);
                return (
                  <Fragment key={model.path}>
                    <Table.Tr>
                      <Table.Td>
                        <ActionIcon
                          aria-label={isOpen ? "Collapse" : "Expand"}
                          variant="subtle"
                          color="gray"
                          onClick={() => toggleExpanded(model.path)}
                        >
                          {isOpen ? (
                            <ChevronDown size={16} />
                          ) : (
                            <ChevronRight size={16} />
                          )}
                        </ActionIcon>
                      </Table.Td>
                      <Table.Td>
                        <Text fw={600} size="sm" lineClamp={1}>
                          {model.name}
                        </Text>
                        <Text c="dimmed" size="xs" lineClamp={1}>
                          {model.path}
                        </Text>
                        {model.error && (
                          <Text c="red" size="xs" lineClamp={1}>
                            {model.error}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Group gap={6} wrap="nowrap">
                          <Text size="sm">
                            {model.metadata.modelType ??
                              model.metadata.architecture ??
                              "-"}
                          </Text>
                          <KindBadge model={model} />
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={6}>
                          <SafetensorsTypeBadge model={model} />
                          <SafetensorsMtpBadge model={model} />
                          <SafetensorsVisionBadge model={model} />
                        </Group>
                      </Table.Td>
                      <Table.Td>{safetensorsParamsLabel(model)}</Table.Td>
                      <Table.Td>{model.metadata.blockCount ?? "-"}</Table.Td>
                      <Table.Td>{model.metadata.contextLength ?? "-"}</Table.Td>
                      <Table.Td>{model.metadata.quantization ?? "-"}</Table.Td>
                      <Table.Td>{formatBytes(model.sizeBytes)}</Table.Td>
                      <Table.Td>
                        <Tooltip
                          label={countLabel(
                            model.weightFiles.length,
                            "weight file",
                          )}
                        >
                          <Text size="sm">{model.weightFiles.length}</Text>
                        </Tooltip>
                      </Table.Td>
                      <Table.Td>
                        <Group justify="flex-end" gap="xs">
                          <Button
                            size="xs"
                            variant="light"
                            disabled={model.metadata.kind !== "model"}
                            onClick={() => props.onUseModel(model)}
                          >
                            Use in new
                          </Button>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                    {isOpen && (
                      <Table.Tr>
                        <Table.Td colSpan={11}>
                          <SafetensorsDetailPanel model={model} />
                        </Table.Td>
                      </Table.Tr>
                    )}
                  </Fragment>
                );
              })}
              {filtered.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={11}>
                    <Text c="dimmed" ta="center" py="lg">
                      No matching safetensors models
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Stack>
  );
}
