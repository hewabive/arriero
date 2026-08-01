import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Loader,
  Modal,
  Paper,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Plus, RefreshCw, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  createPreset,
  getPreset,
  listPresets,
  savePreset,
} from "../../api/client";
import { TouchSelect } from "../components/TouchCombobox";
import { NewPresetModal } from "./presets/NewPresetModal";
import { countLabel } from "../utils/plural";

type SaveState = "idle" | "saving" | "saved" | "error" | "conflict";

export function PresetsView() {
  const queryClient = useQueryClient();
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [newOpen, setNewOpen] = useState(false);

  const baseMtimeRef = useRef<number | null>(null);
  const selectedNameRef = useRef<string | null>(null);

  const presetsQuery = useQuery({
    queryKey: ["presets"],
    queryFn: listPresets,
  });
  const documentQuery = useQuery({
    queryKey: ["preset", selectedName],
    queryFn: () => getPreset(selectedName!),
    enabled: Boolean(selectedName),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const presets = presetsQuery.data?.data ?? [];
  const document = documentQuery.data?.data ?? null;

  useEffect(() => {
    selectedNameRef.current = selectedName;
  }, [selectedName]);

  useEffect(() => {
    if (!presetsQuery.data) {
      return;
    }
    const summaries = presetsQuery.data.data;
    if (selectedName === null && summaries.length > 0) {
      setSelectedName(summaries[0]!.name);
      return;
    }
    if (
      selectedName !== null &&
      !summaries.some((item) => item.name === selectedName)
    ) {
      setSelectedName(summaries[0]?.name ?? null);
    }
  }, [presetsQuery.data, selectedName]);

  useEffect(() => {
    if (!document) {
      return;
    }
    baseMtimeRef.current = document.mtimeMs;
    setContent(document.content);
    setDirty(false);
    setSaveState("idle");
  }, [document]);

  async function persist(force: boolean) {
    const presetName = selectedNameRef.current;
    if (!presetName) {
      return;
    }
    setSaveState("saving");
    try {
      const result = await savePreset(presetName, {
        content,
        expectedMtimeMs: baseMtimeRef.current,
        force,
      });
      if (result.kind === "conflict") {
        setSaveState("conflict");
        return;
      }
      baseMtimeRef.current = result.document.mtimeMs;
      setContent(result.document.content);
      setDirty(false);
      setSaveState("saved");
      void queryClient.invalidateQueries({ queryKey: ["presets"] });
    } catch (error) {
      setSaveState("error");
      notifications.show({
        color: "red",
        title: "Preset save failed",
        message: (error as Error).message,
      });
    }
  }

  const createMutation = useMutation({
    mutationFn: createPreset,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["presets"] });
      setNewOpen(false);
      setSelectedName(result.data.name);
      notifications.show({
        title: "Preset created",
        message: result.data.path,
      });
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: "Preset create failed",
        message: (error as Error).message,
      });
    },
  });

  function reloadFromDisk() {
    void documentQuery.refetch();
  }

  const saveLabel: Record<SaveState, string> = {
    idle: dirty ? "Unsaved changes" : "Up to date",
    saving: "Saving…",
    saved: "Saved",
    error: "Save failed",
    conflict: "File changed on disk",
  };

  const diagnostics = document?.diagnostics ?? [];

  return (
    <>
      <Paper withBorder p="md" radius="sm">
        <Stack gap="md">
          <Group justify="flex-end" align="flex-start">
            <Group gap="xs">
              <Text size="sm" c={saveState === "error" ? "red" : "dimmed"}>
                {saveLabel[saveState]}
              </Text>
              <Tooltip label="Reload from disk">
                <ActionIcon
                  aria-label="Reload preset from disk"
                  variant="subtle"
                  disabled={!selectedName}
                  loading={documentQuery.isFetching}
                  onClick={reloadFromDisk}
                >
                  <RefreshCw size={16} />
                </ActionIcon>
              </Tooltip>
              <Button
                leftSection={<Plus size={16} />}
                onClick={() => setNewOpen(true)}
              >
                New preset
              </Button>
            </Group>
          </Group>

          <TouchSelect
            label="Preset"
            placeholder={
              presetsQuery.isFetching ? "Loading presets..." : "Select a preset"
            }
            searchable
            value={selectedName}
            onChange={setSelectedName}
            data={presets.map((item) => ({
              value: item.name,
              label: `${item.name} · ${countLabel(item.entryCount, "model")}`,
            }))}
            nothingFoundMessage="No presets in data/config/presets"
          />

          {!selectedName && (
            <Paper withBorder p="lg" radius="sm">
              <Text c="dimmed" ta="center">
                Select a preset above or create a new one.
              </Text>
            </Paper>
          )}

          {selectedName && documentQuery.isLoading && (
            <Group justify="center" p="lg">
              <Loader size="sm" />
            </Group>
          )}

          {document && (
            <>
              {diagnostics.length > 0 && (
                <Alert color="yellow" icon={<AlertTriangle size={16} />}>
                  <Stack gap={2}>
                    {diagnostics.map((diagnostic, index) => (
                      <Text key={index} size="xs">
                        {diagnostic.section ? `[${diagnostic.section}] ` : ""}
                        {diagnostic.key ? `${diagnostic.key}: ` : ""}
                        {diagnostic.message}
                        {diagnostic.line ? ` (line ${diagnostic.line})` : ""}
                      </Text>
                    ))}
                  </Stack>
                </Alert>
              )}

              <Textarea
                label={document.path}
                value={content}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setContent(next);
                  setDirty(true);
                  setSaveState("idle");
                }}
                autosize
                minRows={16}
                maxRows={32}
                spellCheck={false}
                styles={{
                  input: {
                    fontFamily: "var(--mantine-font-family-monospace)",
                  },
                }}
              />

              <Group justify="flex-end">
                <Button
                  leftSection={<Save size={16} />}
                  loading={saveState === "saving"}
                  disabled={!dirty}
                  onClick={() => {
                    void persist(false);
                  }}
                >
                  Save
                </Button>
              </Group>
            </>
          )}
        </Stack>
      </Paper>

      <NewPresetModal
        opened={newOpen}
        onClose={() => setNewOpen(false)}
        onCreate={(input) => createMutation.mutate(input)}
        pending={createMutation.isPending}
      />

      <Modal
        opened={saveState === "conflict"}
        onClose={() => setSaveState("idle")}
        title="Preset changed on disk"
      >
        <Stack gap="sm">
          <Text size="sm">
            The file was modified outside the editor since it was loaded. Reload
            to take the on-disk version (your unsaved edits are lost), or
            overwrite it with your current edits.
          </Text>
          <Group justify="flex-end">
            <Button
              variant="subtle"
              onClick={() => {
                setSaveState("idle");
                reloadFromDisk();
              }}
            >
              Reload from disk
            </Button>
            <Button
              color="red"
              onClick={() => {
                void persist(true);
              }}
            >
              Overwrite
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
