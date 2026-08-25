import {
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";

import { formatBytes } from "../utils/models";
import { InstanceFormHostPort } from "./InstanceFormHostPort";
import { MmprojSelect } from "./MmprojSelect";
import { PathPickerInput } from "./PathPickerInput";
import { SecretInput } from "./SecretInput";
import { TouchSelect } from "./TouchCombobox";
import { type LaunchMode, type RemoteSource } from "./instance-form-helpers";
import { type InstanceFormController } from "./use-instance-form";

export function InstanceFormModelSection({
  fm,
}: {
  fm: InstanceFormController;
}) {
  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="xs">
        <SegmentedControl
          value={fm.launchMode}
          onChange={(value) => fm.applyLaunchMode(value as LaunchMode)}
          data={[
            { value: "model", label: "Single model" },
            { value: "remote", label: "Remote (HF/URL)" },
            { value: "router", label: "Router preset" },
          ]}
          fullWidth
        />
        {fm.launchMode === "model" ? (
          <>
            <Stack gap={2}>
              <TouchSelect
                label="Model"
                placeholder={
                  fm.scanned.coldLoading
                    ? "Loading models..."
                    : "Select GGUF model"
                }
                searchable
                clearable
                floatingHeight="viewport"
                loading={fm.scanned.coldLoading}
                value={fm.selectedModelPath}
                onChange={fm.applyModelSelection}
                data={fm.modelOptions}
                nothingFoundMessage={
                  fm.scanned.isError && fm.scanned.error
                    ? fm.scanned.error.message
                    : fm.scanned.coldLoading
                      ? "Loading models..."
                      : "No models found"
                }
              />
              {fm.selectedModelPath && (
                <Text c="dimmed" size="xs" className="text-wrap">
                  {fm.selectedModelPath}
                </Text>
              )}
            </Stack>
            {fm.embeddingHint && !fm.embeddingHint.satisfied && (
              <Alert
                variant="light"
                py="xs"
                color={fm.embeddingHint.role === "reranker" ? "indigo" : "teal"}
                title={
                  fm.embeddingHint.role === "reranker"
                    ? "Reranker model detected"
                    : "Embedding model detected"
                }
              >
                <Stack gap={6} align="flex-start">
                  <Text size="xs">
                    {fm.embeddingHint.role === "reranker"
                      ? "Add --rerank to expose /reranking (sets --embedding + --pooling rank)."
                      : `Add --embedding so the server exposes /v1/embeddings${
                          fm.embeddingHint.pooling
                            ? ` (pooling: ${fm.embeddingHint.pooling})`
                            : ""
                        }.`}
                  </Text>
                  <Button
                    size="xs"
                    variant="light"
                    color={
                      fm.embeddingHint.role === "reranker" ? "indigo" : "teal"
                    }
                    onClick={fm.applyEmbeddingFlag}
                  >
                    Add {fm.embeddingHint.flag}
                  </Button>
                </Stack>
              </Alert>
            )}
            <MmprojSelect
              mmprojPaths={fm.selectedModel?.mmprojPaths ?? []}
              value={fm.mmprojValue || null}
              onChange={fm.applyMmprojSelection}
            />
          </>
        ) : fm.launchMode === "remote" ? (
          <Stack gap="xs">
            <SegmentedControl
              value={fm.remoteSource}
              onChange={(value) => fm.applyRemoteSource(value as RemoteSource)}
              data={[
                { value: "hf", label: "HuggingFace" },
                { value: "url", label: "Direct URL" },
              ]}
              fullWidth
              size="xs"
            />
            {fm.remoteSource === "hf" ? (
              <>
                <TextInput
                  label="HF repo"
                  required
                  autoComplete="off"
                  placeholder="user/repo:Q4_K_M"
                  description="Downloaded lazily by llama-server on first launch. Optional :quant tag — without it, auto-selects Q4_K_M → Q8_0 → first GGUF. mmproj is fetched automatically when present."
                  value={fm.hfRepoValue}
                  onChange={(event) =>
                    fm.applyRemoteRepo(event.currentTarget.value)
                  }
                />
                <TextInput
                  label="HF file"
                  autoComplete="off"
                  placeholder="(optional) exact .gguf filename"
                  description="Overrides the quant tag — pick a specific file in the repo."
                  value={fm.hfFileValue}
                  onChange={(event) =>
                    fm.applyRemoteFile(event.currentTarget.value)
                  }
                />
              </>
            ) : (
              <>
                <TextInput
                  label="Model URL"
                  required
                  autoComplete="off"
                  placeholder="https://.../model.gguf"
                  description="Direct download URL; cached by llama-server on first launch."
                  value={fm.modelUrlValue}
                  onChange={(event) =>
                    fm.applyRemoteUrl(event.currentTarget.value)
                  }
                />
                <PathPickerInput
                  label="Destination path"
                  mode="file"
                  filter="model"
                  value={fm.remoteDestinationValue}
                  onChange={fm.applyRemoteDestination}
                />
                <TextInput
                  label="mmproj URL"
                  autoComplete="off"
                  placeholder="https://.../mmproj.gguf"
                  description="Optional — multimodal projector URL for vision/audio models served from a direct URL."
                  value={fm.mmprojUrlValue}
                  onChange={(event) =>
                    fm.applyMmprojUrl(event.currentTarget.value)
                  }
                />
              </>
            )}
            <SecretInput
              label="HF token"
              placeholder="(optional) for gated/private repos"
              description="Stored in the instance environment as HF_TOKEN — kept out of the command line."
              value={fm.envDraft?.HF_TOKEN ?? ""}
              onChange={(event) => fm.applyHfToken(event.currentTarget.value)}
            />
          </Stack>
        ) : (
          <Stack gap={6}>
            <TouchSelect
              label="Preset"
              placeholder={
                fm.presetsQuery.isFetching
                  ? "Loading presets..."
                  : "Select a preset"
              }
              searchable
              clearable
              loading={fm.presetsQuery.isFetching}
              value={fm.selectedPresetName}
              onChange={(value) => fm.applyPresetSelection(value)}
              data={fm.presetOptions}
              nothingFoundMessage="No presets in data/presets"
            />
            <Text c="dimmed" size="xs">
              Managed in the Presets page; resolved to
              data/presets/&lt;name&gt;.ini at launch.
            </Text>
          </Stack>
        )}
        <InstanceFormHostPort fm={fm} />
        {fm.launchMode === "model" && fm.selectedModel && (
          <Group gap="xs">
            <Badge variant="light">
              {fm.selectedModel.metadata.architecture ?? "unknown arch"}
            </Badge>
            <Badge variant="outline">
              {fm.selectedModel.metadata.quantization ?? "unknown quant"}
            </Badge>
            <Badge variant="outline">
              {formatBytes(fm.selectedModel.sizeBytes)}
            </Badge>
            {fm.selectedModel.mmprojPaths.length > 0 && (
              <Badge variant="outline">
                {fm.selectedModel.mmprojPaths.length} mmproj
              </Badge>
            )}
          </Group>
        )}
      </Stack>
    </Paper>
  );
}
