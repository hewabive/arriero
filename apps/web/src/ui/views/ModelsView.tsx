import type { GgufModel, ModelScanRoot } from "@arriero/core";
import { ggufModelRole, ggufPoolingTypeLabel } from "@arriero/core";
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Collapse,
  Divider,
  Flex,
  Group,
  Modal,
  NumberInput,
  Paper,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";

import {
  createPathCatalogEntry,
  deletePathCatalogEntry,
  getModelScanSettings,
  scanModels,
  updateModelScanSettings,
} from "../../api/client";
import { PathPickerInput } from "../components/PathPickerInput";
import { useScannedModels } from "../hooks/use-scanned-models";
import {
  bitsPerWeight,
  compareModelTitles,
  formatBytes,
  formatParameterCount,
  isVocabModel,
  modelLayerInfo,
  modelMatchesSearch,
  modelTitle,
} from "../utils/models";
import { countLabel } from "../utils/plural";

function rootSourceLabel(root: ModelScanRoot) {
  if (root.source === "settings") {
    return "default";
  }
  if (root.source === "llama-cache") {
    return "llama.cpp cache";
  }
  return "catalog";
}

function paramsLabel(model: GgufModel) {
  return (
    formatParameterCount(model.metadata.parameterCount) ??
    model.metadata.sizeLabel ??
    "-"
  );
}

function formatSampler(value: number) {
  return String(Math.round(value * 1000) / 1000);
}

type DetailRow = [string, string];
type DetailSection = { title: string; rows: DetailRow[] };

function metaSections(model: GgufModel): DetailSection[] {
  const m = model.metadata;
  const section = (title: string) => {
    const rows: DetailRow[] = [];
    const push = (label: string, value: string | number | null | undefined) => {
      if (value !== null && value !== undefined && value !== "") {
        rows.push([label, String(value)]);
      }
    };
    return { title, rows, push };
  };

  const overview = section("Overview");
  overview.push("Name", m.name);
  overview.push("Architecture", m.architecture);
  const role = ggufModelRole(m);
  overview.push("Role", role !== "generative" ? role : null);
  overview.push(
    "Model type",
    m.modelType && m.modelType !== "model" ? m.modelType : null,
  );
  overview.push("Parameters", formatParameterCount(m.parameterCount));
  overview.push("Size label", m.sizeLabel);
  const bpw = bitsPerWeight(model);
  overview.push("Bits per weight", bpw ? bpw.toFixed(2) : null);
  overview.push(
    "Quantization",
    m.quantization
      ? `${m.quantization}${m.quantizationVersion ? ` (v${m.quantizationVersion})` : ""}`
      : null,
  );
  overview.push("File size", formatBytes(model.sizeBytes));

  const arch = section("Architecture");
  const layers = modelLayerInfo(model);
  arch.push("Layers", layers.total);
  if (layers.isMoe) {
    arch.push("Dense layers", layers.dense);
    arch.push("MoE layers", layers.moe);
    arch.push(
      "Experts (used/total)",
      m.expertCount !== null
        ? `${m.expertUsedCount ?? "?"}/${m.expertCount}`
        : null,
    );
    arch.push("Shared experts", m.expertSharedCount);
    arch.push("Expert FFN", m.expertFeedForwardLength);
  }
  arch.push("MTP layers", m.nextnPredictLayers || null);
  arch.push("FFN length", m.feedForwardLength);
  arch.push("Embedding length", m.embeddingLength);
  arch.push("Pooling", ggufPoolingTypeLabel(m.poolingType));
  arch.push(
    "Attention",
    m.causalAttention === null
      ? null
      : m.causalAttention
        ? "causal"
        : "bidirectional",
  );
  arch.push("Attention heads", m.headCount);
  if (m.headCountKv !== null && m.headCount) {
    arch.push(
      "KV heads (GQA)",
      `${m.headCountKv} (${Math.round(m.headCount / m.headCountKv)}:1)`,
    );
  } else {
    arch.push("KV heads", m.headCountKv);
  }
  arch.push("Context (train)", m.contextLength);
  arch.push("Sliding window", m.slidingWindow);
  arch.push("RoPE freq base", m.ropeFreqBase);
  if (m.ropeScalingType) {
    arch.push(
      "RoPE scaling",
      `${m.ropeScalingType}${m.ropeScalingFactor ? ` ×${m.ropeScalingFactor}` : ""}`,
    );
  }
  arch.push("RoPE orig ctx", m.ropeScalingOrigCtxLen);

  const tokenizer = section("Tokenizer");
  tokenizer.push("Vocab size", m.vocabularySize);
  tokenizer.push("Tokenizer", m.tokenizerModel);
  tokenizer.push("Pretokenizer", m.tokenizerPre);
  const addTokens = [
    m.addBosToken === null ? null : `bos ${m.addBosToken ? "yes" : "no"}`,
    m.addEosToken === null ? null : `eos ${m.addEosToken ? "yes" : "no"}`,
  ]
    .filter(Boolean)
    .join(" / ");
  tokenizer.push("Add tokens", addTokens || null);
  tokenizer.push("Chat template", m.hasChatTemplate ? "yes" : null);

  const provenance = section("Provenance");
  provenance.push("Basename", m.basename);
  provenance.push("Finetune", m.finetune);
  provenance.push("License", m.license);
  provenance.push("Version", m.version);
  provenance.push("Quantized by", m.quantizedBy);
  provenance.push("Repo", m.repoUrl);
  const sampling = [
    m.samplingTemp !== null ? `temp ${formatSampler(m.samplingTemp)}` : null,
    m.samplingTopK !== null ? `top_k ${m.samplingTopK}` : null,
    m.samplingTopP !== null ? `top_p ${formatSampler(m.samplingTopP)}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  provenance.push("Rec. sampling", sampling || null);
  if (m.imatrixDataset || m.imatrixEntries !== null) {
    const counts = [
      m.imatrixEntries !== null ? `${m.imatrixEntries} entries` : null,
      m.imatrixChunks !== null ? `${m.imatrixChunks} chunks` : null,
    ]
      .filter(Boolean)
      .join(", ");
    provenance.push(
      "imatrix",
      [m.imatrixDataset, counts ? `(${counts})` : null]
        .filter(Boolean)
        .join(" "),
    );
  }

  return [overview, arch, tokenizer, provenance].map(({ title, rows }) => ({
    title,
    rows,
  }));
}

function RoleBadge(props: { model: GgufModel }) {
  const role = ggufModelRole(props.model.metadata);
  if (role === "generative") {
    return null;
  }
  return (
    <Tooltip label={role}>
      <Badge
        color={role === "reranker" ? "indigo" : "teal"}
        variant="light"
        size="sm"
        style={{ flexShrink: 0 }}
      >
        {role === "reranker" ? "rerank" : "embed"}
      </Badge>
    </Tooltip>
  );
}

function TypeBadge(props: { model: GgufModel }) {
  const m = props.model.metadata;
  const layers = modelLayerInfo(props.model);
  if (!layers.isMoe) {
    return (
      <Text c="dimmed" size="sm">
        dense
      </Text>
    );
  }
  return (
    <Tooltip
      label={`${m.expertUsedCount ?? "?"}/${m.expertCount} experts active`}
    >
      <Badge color="grape" variant="light">
        MoE
      </Badge>
    </Tooltip>
  );
}

function MtpBadge(props: { model: GgufModel }) {
  const mtpLayers = props.model.metadata.nextnPredictLayers;
  if (!mtpLayers) {
    return null;
  }
  return (
    <Tooltip
      label={`${countLabel(mtpLayers, "built-in speculative-decoding layer")} (NextN/MTP)`}
    >
      <Badge color="cyan" variant="light" size="sm" style={{ flexShrink: 0 }}>
        MTP
      </Badge>
    </Tooltip>
  );
}

function LayersCell(props: { model: GgufModel }) {
  const layers = modelLayerInfo(props.model);
  if (layers.total === null) {
    return <>-</>;
  }
  return (
    <div>
      <Text size="sm">{layers.total}</Text>
      {layers.isMoe && layers.moe !== null && (
        <Text c="dimmed" size="xs">
          {layers.dense}D / {layers.moe}E
        </Text>
      )}
    </div>
  );
}

function DetailRows(props: { rows: DetailRow[] }) {
  return (
    <Flex wrap="wrap" rowGap={6} columnGap={24} maw="56rem">
      {props.rows.map(([label, value]) => (
        <Group key={label} gap={6} wrap="nowrap" align="baseline" maw="100%">
          <Text c="dimmed" size="xs" style={{ flexShrink: 0 }}>
            {label}
          </Text>
          <Text
            size="xs"
            style={{
              fontVariantNumeric: "tabular-nums",
              wordBreak: "break-word",
            }}
          >
            {value}
          </Text>
        </Group>
      ))}
    </Flex>
  );
}

function ModelDetailPanel(props: { model: GgufModel }) {
  const sections = metaSections(props.model);
  const m = props.model.metadata;
  const tags = [...new Set(m.tags)];
  const hasBaseModels = m.baseModels.length > 0;
  return (
    <Stack gap="sm">
      {sections.map((section) => {
        const isProvenance = section.title === "Provenance";
        const showExtras = isProvenance && (tags.length > 0 || hasBaseModels);
        if (section.rows.length === 0 && !showExtras) {
          return null;
        }
        return (
          <Stack key={section.title} gap={6}>
            <Divider label={section.title} labelPosition="left" />
            {section.rows.length > 0 && <DetailRows rows={section.rows} />}
            {isProvenance && tags.length > 0 && (
              <Group gap={4}>
                {tags.map((tag) => (
                  <Badge key={tag} size="xs" variant="outline" color="gray">
                    {tag}
                  </Badge>
                ))}
              </Group>
            )}
            {isProvenance && hasBaseModels && (
              <Stack gap={2}>
                <Text c="dimmed" size="xs">
                  Base {m.baseModels.length > 1 ? "models" : "model"}
                </Text>
                {m.baseModels.map((base, index) => {
                  const label = [base.name, base.organization]
                    .filter(Boolean)
                    .join(" · ");
                  return base.repoUrl ? (
                    <Anchor
                      key={base.repoUrl}
                      href={base.repoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      size="xs"
                    >
                      {label || base.repoUrl}
                    </Anchor>
                  ) : (
                    <Text key={base.name ?? String(index)} size="xs">
                      {label}
                    </Text>
                  );
                })}
              </Stack>
            )}
          </Stack>
        );
      })}
      <Text c="dimmed" size="xs" className="text-wrap">
        {props.model.path}
      </Text>
      {props.model.mmprojPaths.length > 0 && (
        <Text c="dimmed" size="xs" className="text-wrap">
          mmproj: {props.model.mmprojPaths.join(", ")}
        </Text>
      )}
    </Stack>
  );
}

export function ModelsView(props: { onUseModel: (model: GgufModel) => void }) {
  const queryClient = useQueryClient();
  const [directory, setDirectory] = useState("");
  const [maxDepth, setMaxDepth] = useState(8);
  const [search, setSearch] = useState("");
  const [hideVocab, setHideVocab] = useState(true);
  const [hideMmproj, setHideMmproj] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [addDirOpen, setAddDirOpen] = useState(false);
  const [dirDraft, setDirDraft] = useState({ name: "", path: "" });
  const settingsQuery = useQuery({
    queryKey: ["model-scan-settings"],
    queryFn: getModelScanSettings,
  });
  const scanned = useScannedModels();
  const refreshModelsMutation = useMutation({
    mutationFn: () => scanModels({ refresh: true }),
    onSuccess: (result) => {
      queryClient.setQueryData(["models"], result);
      queryClient.setQueryData(["models", "cache"], result);
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Metadata refresh failed",
        message: (error as Error).message,
      });
    },
  });
  const settingsMutation = useMutation({
    mutationFn: updateModelScanSettings,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["model-scan-settings"],
      });
      await queryClient.invalidateQueries({ queryKey: ["models"] });
      notifications.show({
        title: "Scanner settings saved",
        message: directory,
      });
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Settings save failed",
        message: (error as Error).message,
      });
    },
  });
  const addDirMutation = useMutation({
    mutationFn: () =>
      createPathCatalogEntry({
        kind: "models-dir",
        name: dirDraft.name.trim(),
        path: dirDraft.path.trim(),
      }),
    onSuccess: async (result) => {
      setAddDirOpen(false);
      setDirDraft({ name: "", path: "" });
      await queryClient.invalidateQueries({ queryKey: ["path-catalog"] });
      await queryClient.invalidateQueries({ queryKey: ["models"] });
      notifications.show({
        title: "Model directory added",
        message: result.data.name,
      });
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Model directory add failed",
        message: (error as Error).message,
      });
    },
  });
  const removeDirMutation = useMutation({
    mutationFn: deletePathCatalogEntry,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["path-catalog"] });
      await queryClient.invalidateQueries({ queryKey: ["models"] });
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Model directory remove failed",
        message: (error as Error).message,
      });
    },
  });
  const settingsDirectory = settingsQuery.data?.data.directory;
  const settingsMaxDepth = settingsQuery.data?.data.maxDepth;

  useEffect(() => {
    if (settingsDirectory && settingsMaxDepth !== undefined) {
      setDirectory(settingsDirectory);
      setMaxDepth(settingsMaxDepth);
    }
  }, [settingsDirectory, settingsMaxDepth]);

  function requestScan() {
    if (directory !== settingsDirectory || maxDepth !== settingsMaxDepth) {
      settingsMutation.mutate({ directory, maxDepth });
      return;
    }
    scanned.refetch();
  }

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
    () => [...scanned.models].sort(compareModelTitles),
    [scanned.models],
  );
  const filteredModels = models.filter((model) => {
    if (hideVocab && isVocabModel(model)) {
      return false;
    }
    if (hideMmproj && model.isMmproj) {
      return false;
    }
    return modelMatchesSearch(model, search);
  });

  const emptyMessage =
    scanned.coldLoading || settingsQuery.isFetching
      ? "Scanning models..."
      : scanned.fetched
        ? "No matching GGUF files found"
        : "Run scan to list models";

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Group
          className="model-scan-controls"
          gap="xs"
          align="flex-end"
          wrap="wrap"
        >
          <PathPickerInput
            aria-label="Directory"
            label="Directory"
            mode="directory"
            value={directory}
            onChange={setDirectory}
            className="model-directory-input"
          />
          <NumberInput
            aria-label="Depth"
            label="Depth"
            value={maxDepth}
            min={0}
            max={16}
            clampBehavior="strict"
            onChange={(value) =>
              setMaxDepth(typeof value === "number" ? value : 8)
            }
            w={92}
          />
          <Button
            aria-label="Scan model directories"
            onClick={requestScan}
            loading={scanned.reconciling || settingsMutation.isPending}
          >
            Scan
          </Button>
          <Button
            aria-label="Refresh model metadata"
            variant="subtle"
            onClick={() => refreshModelsMutation.mutate()}
            loading={scanned.reconciling || refreshModelsMutation.isPending}
          >
            Refresh metadata
          </Button>
        </Group>

        {scanned.isError && scanned.error && (
          <Text c="red" size="sm">
            {scanned.error.message}
          </Text>
        )}

        <Paper withBorder p="sm" radius="sm">
          <Stack gap="xs">
            <Group justify="space-between" align="center">
              <Text fw={600} size="sm">
                Scanned directories
              </Text>
              <Button
                size="xs"
                variant="light"
                leftSection={<Plus size={14} />}
                onClick={() => setAddDirOpen(true)}
              >
                Add directory
              </Button>
            </Group>
            {scanned.roots.map((root) => {
              const count = scanned.models.filter((model) =>
                model.path.startsWith(`${root.path}/`),
              ).length;
              return (
                <Group key={root.path} gap="xs" wrap="nowrap">
                  <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                    <Group gap="xs" wrap="wrap">
                      <Text size="sm" fw={500}>
                        {root.label}
                      </Text>
                      <Badge
                        variant={
                          root.source === "settings" ? "light" : "outline"
                        }
                        color={root.source === "llama-cache" ? "grape" : "blue"}
                      >
                        {rootSourceLabel(root)}
                      </Badge>
                      {!root.exists && (
                        <Badge color="red" variant="light">
                          missing
                        </Badge>
                      )}
                      <Badge variant="outline" color="gray">
                        {countLabel(count, "model")}
                      </Badge>
                    </Group>
                    <Text c="dimmed" size="xs" className="text-wrap">
                      {root.path}
                    </Text>
                  </Stack>
                  {root.source === "catalog" && root.refId && (
                    <Tooltip label="Remove from scan list">
                      <ActionIcon
                        aria-label={`Remove ${root.label}`}
                        color="red"
                        variant="subtle"
                        loading={removeDirMutation.isPending}
                        onClick={() => removeDirMutation.mutate(root.refId!)}
                      >
                        <Trash2 size={16} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </Group>
              );
            })}
            {scanned.roots.length === 0 && (
              <Text c="dimmed" size="sm">
                {scanned.coldLoading ? "Loading…" : "No directories configured"}
              </Text>
            )}
          </Stack>
        </Paper>

        <Group justify="space-between" align="flex-end" wrap="wrap">
          <TextInput
            aria-label="Search models"
            label="Search"
            placeholder="name, path, architecture, quant, size"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            className="search-input"
          />
          <Group gap="lg" pb={4} wrap="wrap">
            <Switch
              label="Hide vocab/test files"
              checked={hideVocab}
              onChange={(event) => setHideVocab(event.currentTarget.checked)}
            />
            <Switch
              label="Hide mmproj"
              checked={hideMmproj}
              onChange={(event) => setHideMmproj(event.currentTarget.checked)}
            />
            <Badge variant="light">
              {filteredModels.length}/{models.length}
            </Badge>
            {scanned.cache && (
              <Badge variant="outline">
                cache {scanned.cache.hits}/{scanned.cache.misses}
              </Badge>
            )}
          </Group>
        </Group>

        <Stack className="models-mobile-list" gap="xs">
          {filteredModels.map((model) => {
            const isOpen = expanded.has(model.path);
            return (
              <Paper key={model.path} withBorder p="sm" radius="sm">
                <Stack gap="xs">
                  <div>
                    <Text fw={600} size="sm">
                      {modelTitle(model)}
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
                      {model.metadata.architecture ?? "unknown arch"}
                    </Badge>
                    <TypeBadge model={model} />
                    <MtpBadge model={model} />
                    <RoleBadge model={model} />
                    <Badge variant="outline">{paramsLabel(model)}</Badge>
                    <Badge variant="outline">
                      {model.metadata.quantization ?? "unknown quant"}
                    </Badge>
                    <Badge variant="outline">
                      {formatBytes(model.sizeBytes)}
                    </Badge>
                    <Badge variant="outline">
                      ctx {model.metadata.contextLength ?? "-"}
                    </Badge>
                  </Group>
                  <Collapse in={isOpen}>
                    <ModelDetailPanel model={model} />
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
                      disabled={model.isMmproj}
                      onClick={() => props.onUseModel(model)}
                    >
                      Use in new
                    </Button>
                  </Group>
                </Stack>
              </Paper>
            );
          })}
          {filteredModels.length === 0 && (
            <Paper withBorder p="md" radius="sm">
              <Text c="dimmed" ta="center">
                {emptyMessage}
              </Text>
            </Paper>
          )}
        </Stack>

        <Table.ScrollContainer className="models-table" minWidth={1120}>
          <Table striped highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={36} />
                <Table.Th>Model</Table.Th>
                <Table.Th>Arch</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th>Params</Table.Th>
                <Table.Th>Layers</Table.Th>
                <Table.Th>Ctx</Table.Th>
                <Table.Th>Quant</Table.Th>
                <Table.Th>Size</Table.Th>
                <Table.Th>mmproj</Table.Th>
                <Table.Th ta="right">Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {filteredModels.map((model) => {
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
                          {modelTitle(model)}
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
                            {model.metadata.architecture ?? "-"}
                          </Text>
                          <RoleBadge model={model} />
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={6} wrap="nowrap">
                          <TypeBadge model={model} />
                          <MtpBadge model={model} />
                        </Group>
                      </Table.Td>
                      <Table.Td>{paramsLabel(model)}</Table.Td>
                      <Table.Td>
                        <LayersCell model={model} />
                      </Table.Td>
                      <Table.Td>{model.metadata.contextLength ?? "-"}</Table.Td>
                      <Table.Td>{model.metadata.quantization ?? "-"}</Table.Td>
                      <Table.Td>{formatBytes(model.sizeBytes)}</Table.Td>
                      <Table.Td>
                        {model.isMmproj
                          ? "projector"
                          : model.mmprojPaths.length || "-"}
                      </Table.Td>
                      <Table.Td>
                        <Group justify="flex-end" gap="xs">
                          <Button
                            size="xs"
                            variant="light"
                            disabled={model.isMmproj}
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
                          <ModelDetailPanel model={model} />
                        </Table.Td>
                      </Table.Tr>
                    )}
                  </Fragment>
                );
              })}
              {filteredModels.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={11}>
                    <Text c="dimmed" ta="center" py="lg">
                      {emptyMessage}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Stack>

      <Modal
        opened={addDirOpen}
        onClose={() => setAddDirOpen(false)}
        title="Add model directory"
      >
        <Stack gap="sm">
          <TextInput
            label="Name"
            placeholder="e.g. external-ssd"
            value={dirDraft.name}
            onChange={(event) => {
              const name = event.currentTarget.value;
              setDirDraft((current) => ({ ...current, name }));
            }}
          />
          <PathPickerInput
            label="Directory"
            mode="directory"
            value={dirDraft.path}
            onChange={(path) =>
              setDirDraft((current) => ({ ...current, path }))
            }
          />
          <Group justify="flex-end" gap="xs">
            <Button variant="subtle" onClick={() => setAddDirOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={addDirMutation.isPending}
              disabled={!dirDraft.name.trim() || !dirDraft.path.trim()}
              onClick={() => addDirMutation.mutate()}
            >
              Add
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  );
}
