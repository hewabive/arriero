import {
  Button,
  Collapse,
  NumberInput,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { ChevronDown, ChevronRight } from "lucide-react";

import { PathPickerInput } from "./PathPickerInput";
import { TouchSelect } from "./TouchCombobox";
import { rowValue } from "./InstanceArgumentRows";
import { SPEC_TYPE_KEY, type DraftSource } from "./instance-form-helpers";
import { type InstanceFormController } from "./use-instance-form";

export function InstanceFormSpecSection({
  fm,
}: {
  fm: InstanceFormController;
}) {
  if (fm.launchMode === "router") {
    return null;
  }
  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="xs">
        <Switch
          checked={fm.specEnabled}
          onChange={(event) => fm.applySpecEnabled(event.currentTarget.checked)}
          label="Speculative decoding (draft model)"
        />
        <Collapse expanded={fm.specEnabled}>
          <Stack gap="xs">
            {fm.specTypeOptions.length > 0 ? (
              <TouchSelect
                label="Mechanism (--spec-type)"
                clearable
                searchable
                placeholder="draft-simple (default)"
                value={fm.specTypeValue || null}
                onChange={(value) =>
                  fm.applySpecArg(SPEC_TYPE_KEY, value ?? "", "list")
                }
                data={fm.specTypeOptions}
              />
            ) : (
              <TextInput
                label="Mechanism (--spec-type)"
                autoComplete="off"
                placeholder="draft-simple (default)"
                value={fm.specTypeValue}
                onChange={(event) =>
                  fm.applySpecArg(
                    SPEC_TYPE_KEY,
                    event.currentTarget.value,
                    "list",
                  )
                }
              />
            )}
            <SegmentedControl
              value={fm.specSource}
              onChange={(value) => fm.applySpecSource(value as DraftSource)}
              data={[
                { value: "local", label: "Local" },
                { value: "hf", label: "HuggingFace" },
              ]}
              fullWidth
              size="xs"
            />
            {fm.specSource === "local" ? (
              <>
                <TouchSelect
                  label="Draft model"
                  placeholder={
                    fm.scanned.coldLoading
                      ? "Loading models..."
                      : "Select GGUF model"
                  }
                  searchable
                  clearable
                  floatingHeight="viewport"
                  loading={fm.scanned.coldLoading}
                  value={fm.specDraftModelValue || null}
                  onChange={fm.applySpecDraftModel}
                  data={fm.draftModelOptions}
                  nothingFoundMessage="No models found"
                />
                <PathPickerInput
                  label="Draft model path"
                  mode="file"
                  filter="model"
                  value={fm.specDraftModelValue}
                  onChange={(value) => fm.applySpecDraftModel(value)}
                />
              </>
            ) : (
              <TextInput
                label="Draft HF repo (--spec-draft-hf)"
                autoComplete="off"
                placeholder="user/repo:Q4_K_M"
                description="Downloaded lazily before the speculative context loads. HF token is read from HF_TOKEN in env, same as the main model."
                value={fm.specDraftHfValue}
                onChange={(event) =>
                  fm.applySpecDraftHf(event.currentTarget.value)
                }
              />
            )}
            {fm.draftVocabHint && (
              <Text size="xs" c={fm.draftVocabHint.ok ? "green" : "yellow"}>
                {fm.draftVocabHint.ok
                  ? fm.draftVocabHint.sidecarKind
                    ? `✓ ${fm.draftVocabHint.sidecarKind.replace("draft-", "").toUpperCase()} sidecar vocab matches the main model`
                    : `✓ vocab matches the main model (${fm.draftVocabHint.mainArch})`
                  : fm.draftVocabHint.sidecarKind
                    ? `⚠ speculative sidecar vocab differs from the main model — startup may fail`
                    : `⚠ draft arch (${fm.draftVocabHint.draftArch}) ≠ main (${fm.draftVocabHint.mainArch}) — speculative may fail to start`}
              </Text>
            )}
            <Button
              variant="subtle"
              size="xs"
              px={0}
              justify="flex-start"
              leftSection={
                fm.specAdvancedOpen ? (
                  <ChevronDown size={14} />
                ) : (
                  <ChevronRight size={14} />
                )
              }
              onClick={() => fm.setSpecAdvancedOpen((open) => !open)}
            >
              Advanced
            </Button>
            <Collapse expanded={fm.specAdvancedOpen}>
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                <NumberInput
                  label="draft-n-max"
                  description="Max draft sequence length"
                  min={0}
                  value={
                    rowValue(fm.argRows, "--spec-draft-n-max") === ""
                      ? ""
                      : Number(rowValue(fm.argRows, "--spec-draft-n-max"))
                  }
                  onChange={(value) =>
                    fm.applySpecArg(
                      "--spec-draft-n-max",
                      typeof value === "number" ? String(value) : "",
                      "number",
                    )
                  }
                />
                <NumberInput
                  label="draft-n-min"
                  description="Min length before a draft is accepted"
                  min={0}
                  value={
                    rowValue(fm.argRows, "--spec-draft-n-min") === ""
                      ? ""
                      : Number(rowValue(fm.argRows, "--spec-draft-n-min"))
                  }
                  onChange={(value) =>
                    fm.applySpecArg(
                      "--spec-draft-n-min",
                      typeof value === "number" ? String(value) : "",
                      "number",
                    )
                  }
                />
                <NumberInput
                  label="draft-p-min"
                  description="Draft candidate probability threshold"
                  min={0}
                  max={1}
                  step={0.05}
                  decimalScale={2}
                  value={
                    rowValue(fm.argRows, "--spec-draft-p-min") === ""
                      ? ""
                      : Number(rowValue(fm.argRows, "--spec-draft-p-min"))
                  }
                  onChange={(value) =>
                    fm.applySpecArg(
                      "--spec-draft-p-min",
                      typeof value === "number" ? String(value) : "",
                      "number",
                    )
                  }
                />
                <NumberInput
                  label="draft-ngl"
                  description="Draft model layers offloaded to GPU"
                  min={0}
                  value={
                    rowValue(fm.argRows, "--spec-draft-ngl") === ""
                      ? ""
                      : Number(rowValue(fm.argRows, "--spec-draft-ngl"))
                  }
                  onChange={(value) =>
                    fm.applySpecArg(
                      "--spec-draft-ngl",
                      typeof value === "number" ? String(value) : "",
                      "number",
                    )
                  }
                />
                <NumberInput
                  label="draft-threads"
                  description="CPU threads for the draft context"
                  min={1}
                  value={
                    rowValue(fm.argRows, "--spec-draft-threads") === ""
                      ? ""
                      : Number(rowValue(fm.argRows, "--spec-draft-threads"))
                  }
                  onChange={(value) =>
                    fm.applySpecArg(
                      "--spec-draft-threads",
                      typeof value === "number" ? String(value) : "",
                      "number",
                    )
                  }
                />
                <TextInput
                  label="draft-device"
                  description="Draft device list (CUDA0,CUDA1)"
                  autoComplete="off"
                  value={rowValue(fm.argRows, "--spec-draft-device")}
                  onChange={(event) =>
                    fm.applySpecArg(
                      "--spec-draft-device",
                      event.currentTarget.value,
                      "string",
                    )
                  }
                />
              </SimpleGrid>
            </Collapse>
          </Stack>
        </Collapse>
      </Stack>
    </Paper>
  );
}
