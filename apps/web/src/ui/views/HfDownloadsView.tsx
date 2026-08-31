import type { HfDownloadQueueJob, HfDownloadSettings } from "@arriero/core";
import {
  Badge,
  Button,
  Group,
  NumberInput,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import {
  getHfDownloadSettings,
  getHfTokenStatus,
  updateHfDownloadSettings,
  updateHfToken,
} from "../../api/client";
import { SecretInput } from "../components/SecretInput";
import { HfDownloadedReposPanel } from "./HfDownloadedReposPanel";
import { HfRequirementsCard } from "./HfRequirementsCard";
import { HfQueuePanel } from "./HfQueuePanel";
import { HfRepoBrowserPanel } from "./HfRepoBrowserPanel";
import { useHfJobsSync } from "./use-hf-queue";
import { notifyError } from "../utils/notify";

function HfTokenCard() {
  const queryClient = useQueryClient();
  const tokenQuery = useQuery({
    queryKey: ["hf-token"],
    queryFn: getHfTokenStatus,
  });
  const configured = tokenQuery.data?.data.tokenConfigured ?? false;
  const [draft, setDraft] = useState("");
  const mutation = useMutation({
    mutationFn: (token: string | null) => updateHfToken(token),
    onSuccess: (result, token) => {
      queryClient.setQueryData(["hf-token"], result);
      setDraft("");
      notifications.show({
        title: "HuggingFace token",
        message: token ? "Token saved." : "Token removed.",
      });
    },
    onError: notifyError("HuggingFace token"),
  });

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Group gap="xs">
          <Title order={4}>Access token</Title>
          <Badge color={configured ? "green" : "gray"} variant="light">
            {configured ? "configured" : "not set"}
          </Badge>
        </Group>
        <Text size="sm" c="dimmed">
          Needed only for gated or private repositories. The token is stored in
          the local secrets file and is never shown again.
        </Text>
        <Group align="flex-end" gap="sm" wrap="wrap">
          <SecretInput
            label="Token"
            placeholder="hf_…"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            w={320}
          />
          <Button
            onClick={() => mutation.mutate(draft.trim())}
            disabled={draft.trim().length === 0}
            loading={mutation.isPending}
          >
            {configured ? "Replace" : "Save"}
          </Button>
          {configured && (
            <Button
              variant="default"
              onClick={() => mutation.mutate(null)}
              loading={mutation.isPending}
            >
              Remove
            </Button>
          )}
        </Group>
      </Stack>
    </Paper>
  );
}

function HfDownloadSettingsCard() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["hf-download-settings"],
    queryFn: getHfDownloadSettings,
  });
  const settings = settingsQuery.data?.data ?? null;
  const [maxEta, setMaxEta] = useState<number | "off" | null>(null);
  const mutation = useMutation({
    mutationFn: (input: HfDownloadSettings) => updateHfDownloadSettings(input),
    onSuccess: (result) => {
      queryClient.setQueryData(["hf-download-settings"], result);
      setMaxEta(null);
      notifications.show({
        title: "Download settings",
        message: "Settings saved.",
      });
    },
    onError: notifyError("Download settings"),
  });
  if (!settings) {
    return null;
  }
  const effectiveMaxEta = maxEta ?? settings.maxEtaHours ?? "off";
  const effectiveMaxEtaValue =
    effectiveMaxEta === "off" ? null : effectiveMaxEta;
  const dirty = effectiveMaxEtaValue !== settings.maxEtaHours;

  return (
    <Paper withBorder p="md" radius="sm">
      <Stack gap="sm">
        <Title order={4}>Download settings</Title>
        <Text size="sm" c="dimmed">
          Connection count and chunk size are tuned automatically for each
          download. If the projected finish time exceeds the max ETA, the job
          pauses instead of grinding for hours. Clear the field to switch that
          safeguard off.
        </Text>
        <Group align="flex-end" gap="sm" wrap="wrap">
          <NumberInput
            label="Max ETA (hours)"
            min={1}
            max={720}
            value={effectiveMaxEta === "off" ? "" : effectiveMaxEta}
            onChange={(value) =>
              setMaxEta(typeof value === "number" ? value : "off")
            }
            w={160}
          />
          <Button
            onClick={() =>
              mutation.mutate({
                modelDirectoryId: settings.modelDirectoryId,
                maxEtaHours: effectiveMaxEtaValue,
              })
            }
            disabled={!dirty}
            loading={mutation.isPending}
          >
            Save
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

export function HfDownloadsView() {
  useHfJobsSync();
  const queuePanelRef = useRef<HTMLDivElement>(null);
  const [highlightJobId, setHighlightJobId] = useState<string | null>(null);

  useEffect(() => {
    if (!highlightJobId) {
      return;
    }
    const timer = setTimeout(() => setHighlightJobId(null), 1_600);
    return () => clearTimeout(timer);
  }, [highlightJobId]);

  const handleEnqueued = (job: HfDownloadQueueJob) => {
    setHighlightJobId(job.id);
    queuePanelRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  return (
    <Stack gap="md">
      <HfRepoBrowserPanel onEnqueued={handleEnqueued} />
      <HfQueuePanel ref={queuePanelRef} highlightJobId={highlightJobId} />
      <HfDownloadedReposPanel />
      <HfRequirementsCard />
      <HfDownloadSettingsCard />
      <HfTokenCard />
    </Stack>
  );
}
