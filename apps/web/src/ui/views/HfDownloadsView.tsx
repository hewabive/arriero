import { Badge, Button, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { getHfTokenStatus, updateHfToken } from "../../api/client";
import { SecretInput } from "../components/SecretInput";
import { HfDownloadJobsPanel } from "./HfDownloadJobsPanel";
import { HfDownloadedReposPanel } from "./HfDownloadedReposPanel";
import { HfRepoBrowserPanel } from "./HfRepoBrowserPanel";

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
    onError: (error) =>
      notifications.show({
        color: "red",
        title: "HuggingFace token",
        message: (error as Error).message,
      }),
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

export function HfDownloadsView() {
  return (
    <Stack gap="md">
      <HfRepoBrowserPanel />
      <HfDownloadJobsPanel />
      <HfDownloadedReposPanel />
      <HfTokenCard />
    </Stack>
  );
}
