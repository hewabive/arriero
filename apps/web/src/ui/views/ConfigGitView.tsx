import type { ConfigGitMutationResult, ConfigGitStatus } from "@arriero/core";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  Group,
  Modal,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import {
  checkoutConfigCommit,
  cloneConfigRepository,
  commitConfigChanges,
  createConfigBranch,
  fetchConfigRepository,
  getConfigGitDiff,
  getConfigGitLog,
  getConfigGitStatus,
  getConfigGitValidation,
  pullConfigRepository,
  pushConfigRepository,
  resetConfigChanges,
  switchConfigBranch,
} from "../../api/client";
import { formatLocalDateTime } from "../utils/time";

type MutationResponse = { data: ConfigGitMutationResult };

function useConfigMutation<T>(
  title: string,
  mutationFn: (input: T) => Promise<MutationResponse>,
  afterSuccess?: () => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["config-git-status"] }),
        queryClient.invalidateQueries({ queryKey: ["config-git-diff"] }),
        queryClient.invalidateQueries({ queryKey: ["config-git-log"] }),
        queryClient.invalidateQueries({
          queryKey: ["config-git-validation"],
        }),
        queryClient.invalidateQueries({ queryKey: ["instances"] }),
        queryClient.invalidateQueries({ queryKey: ["proxy-config"] }),
      ]);
      afterSuccess?.();
      const backup = result.data.backupPath
        ? ` Backup: ${result.data.backupPath}`
        : "";
      notifications.show({
        title,
        message: `${result.data.output.slice(0, 300) || "Completed successfully"}${backup}`,
      });
    },
    onError: (error) => {
      notifications.show({
        color: "red",
        title: `${title} failed`,
        message: (error as Error).message,
      });
    },
  });
}

function statusColor(status: ConfigGitStatus) {
  if (!status.isGitRepo) return "gray";
  if (status.error) return "red";
  if (status.dirty) return "yellow";
  if ((status.behind ?? 0) > 0) return "blue";
  return "teal";
}

function statusLabel(status: ConfigGitStatus) {
  if (!status.isGitRepo) return "not cloned";
  if (status.error) return "error";
  if (status.dirty) return "dirty";
  if ((status.behind ?? 0) > 0) return `${status.behind} behind`;
  return "clean";
}

export function ConfigGitView() {
  const [originUrl, setOriginUrl] = useState("");
  const [cloneBranch, setCloneBranch] = useState("");
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [authorEmail, setAuthorEmail] = useState("");
  const [resetOpened, setResetOpened] = useState(false);
  const [includeUntracked, setIncludeUntracked] = useState(false);

  const statusQuery = useQuery({
    queryKey: ["config-git-status"],
    queryFn: getConfigGitStatus,
    refetchInterval: 10_000,
  });
  const status = statusQuery.data?.data ?? null;
  const validationQuery = useQuery({
    queryKey: ["config-git-validation"],
    queryFn: getConfigGitValidation,
  });
  const diffQuery = useQuery({
    queryKey: ["config-git-diff"],
    queryFn: getConfigGitDiff,
    enabled: status?.isGitRepo === true,
  });
  const logQuery = useQuery({
    queryKey: ["config-git-log"],
    queryFn: () => getConfigGitLog(50),
    enabled: status?.isGitRepo === true,
  });

  useEffect(() => {
    if (!status) return;
    setAuthorName((current) => current || status.authorName || "");
    setAuthorEmail((current) => current || status.authorEmail || "");
  }, [status?.authorName, status?.authorEmail]);

  const cloneMutation = useConfigMutation(
    "Configuration cloned",
    (input: {
      originUrl: string;
      branch: string | null;
      replaceExisting: boolean;
    }) => cloneConfigRepository(input),
  );
  const fetchMutation = useConfigMutation("Origin fetched", () =>
    fetchConfigRepository(),
  );
  const pullMutation = useConfigMutation("Configuration pulled", () =>
    pullConfigRepository(),
  );
  const pushMutation = useConfigMutation("Configuration pushed", () =>
    pushConfigRepository(),
  );
  const switchMutation = useConfigMutation(
    "Configuration branch switched",
    (branch: string) => switchConfigBranch({ branch }),
  );
  const createBranchMutation = useConfigMutation(
    "Configuration branch created",
    (branch: string) => createConfigBranch({ branch, startPoint: null }),
    () => setNewBranch(""),
  );
  const checkoutMutation = useConfigMutation(
    "Commit checked out",
    (commit: string) => checkoutConfigCommit({ commit }),
  );
  const commitMutation = useConfigMutation(
    "Configuration committed",
    () =>
      commitConfigChanges({
        message: commitMessage,
        authorName: authorName.trim() || null,
        authorEmail: authorEmail.trim() || null,
      }),
    () => setCommitMessage(""),
  );
  const resetMutation = useConfigMutation(
    "Configuration changes discarded",
    () => resetConfigChanges({ includeUntracked, confirm: true }),
    () => {
      setResetOpened(false);
      setIncludeUntracked(false);
    },
  );

  const mutations = [
    cloneMutation,
    fetchMutation,
    pullMutation,
    pushMutation,
    switchMutation,
    createBranchMutation,
    checkoutMutation,
    commitMutation,
    resetMutation,
  ];
  const busy = mutations.some((mutation) => mutation.isPending);
  const branchOptions = useMemo(() => {
    if (!status) return [];
    const local = status.branches.map((branch) => ({
      value: branch.name,
      label: branch.upstream
        ? `${branch.name} · ${branch.ahead ?? 0}↑ ${branch.behind ?? 0}↓`
        : branch.name,
    }));
    const localNames = new Set(status.branches.map((branch) => branch.name));
    const remote = status.remoteBranches
      .filter((branch) => !localNames.has(branch))
      .map((branch) => ({ value: branch, label: `${branch} · origin` }));
    return [
      ...(local.length > 0 ? [{ group: "Local", items: local }] : []),
      ...(remote.length > 0 ? [{ group: "Remote", items: remote }] : []),
    ];
  }, [status]);

  if (statusQuery.isLoading || !status) {
    return <Text c="dimmed">Loading configuration repository…</Text>;
  }

  if (!status.isGitRepo) {
    return (
      <Stack gap="md">
        <Alert color="blue" title="Bootstrap configuration">
          Clone is staged and validated before it replaces the local bootstrap
          files. The previous directory is retained as a timestamped backup, and
          local .secrets.json is preserved.
        </Alert>
        <Card withBorder radius="md" padding="md">
          <Stack gap="sm">
            <Text fw={600}>Clone configuration repository</Text>
            <Text size="sm" c="dimmed">
              Destination: <Code>{status.configDir}</Code>
            </Text>
            <TextInput
              label="Origin URL"
              placeholder="git@github.com:team/llama-config.git"
              value={originUrl}
              onChange={(event) => setOriginUrl(event.currentTarget.value)}
            />
            <TextInput
              label="Initial branch"
              description="Leave empty to use the origin default branch."
              placeholder="main"
              value={cloneBranch}
              onChange={(event) => setCloneBranch(event.currentTarget.value)}
            />
            <Checkbox
              checked={replaceExisting}
              onChange={(event) =>
                setReplaceExisting(event.currentTarget.checked)
              }
              label="Replace the generated bootstrap configuration after validation"
            />
            <Group justify="flex-end">
              <Button
                loading={cloneMutation.isPending}
                disabled={!originUrl.trim() || !replaceExisting}
                onClick={() =>
                  cloneMutation.mutate({
                    originUrl: originUrl.trim(),
                    branch: cloneBranch.trim() || null,
                    replaceExisting,
                  })
                }
              >
                Clone and activate
              </Button>
            </Group>
          </Stack>
        </Card>
      </Stack>
    );
  }

  const validation = validationQuery.data?.data;
  const diff = diffQuery.data?.data;
  const commits = logQuery.data?.data ?? [];

  return (
    <Stack gap="md">
      {status.error && <Alert color="red">{status.error}</Alert>}
      {validation && !validation.valid && (
        <Alert color="red" title="Configuration validation failed">
          <Stack gap={2}>
            {validation.issues.slice(0, 10).map((issue, index) => (
              <Text key={`${issue.path}:${index}`} size="sm">
                <Code>{issue.path}</Code> {issue.message}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
      <Card withBorder radius="md" padding="md">
        <Stack gap="sm">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <Stack gap={4}>
              <Group gap="xs">
                <Badge color={statusColor(status)} variant="light">
                  {statusLabel(status)}
                </Badge>
                {status.detached && (
                  <Badge color="orange" variant="outline">
                    detached HEAD
                  </Badge>
                )}
                {status.shortHead && <Code>{status.shortHead}</Code>}
                {status.ahead !== null && (
                  <Text size="sm" c="dimmed">
                    {status.ahead} ahead · {status.behind} behind
                  </Text>
                )}
              </Group>
              <Text size="sm">
                <Code>{status.configDir}</Code>
              </Text>
              <Text size="sm" c="dimmed" className="text-wrap">
                {status.originUrl ?? "origin is not configured"}
              </Text>
            </Stack>
            <Group gap="xs">
              <Button
                variant="default"
                loading={fetchMutation.isPending}
                disabled={busy || !status.originUrl}
                onClick={() => fetchMutation.mutate(undefined)}
              >
                Fetch
              </Button>
              <Button
                variant="default"
                loading={pullMutation.isPending}
                disabled={
                  busy ||
                  status.dirty ||
                  status.detached ||
                  !status.originUrl ||
                  !status.upstream
                }
                onClick={() => pullMutation.mutate(undefined)}
              >
                Pull
              </Button>
              <Button
                loading={pushMutation.isPending}
                disabled={busy || status.detached || !status.originUrl}
                onClick={() => pushMutation.mutate(undefined)}
              >
                Push
              </Button>
            </Group>
          </Group>

          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
            <Select
              label="Branch"
              placeholder={status.detached ? "Detached HEAD" : "Select branch"}
              data={branchOptions}
              searchable
              value={status.branch}
              disabled={busy || status.dirty}
              onChange={(branch) => {
                if (branch && branch !== status.branch) {
                  switchMutation.mutate(branch);
                }
              }}
            />
            <Group align="flex-end" grow>
              <TextInput
                label="New branch"
                placeholder="gpu-h100"
                value={newBranch}
                disabled={busy || status.dirty}
                onChange={(event) => setNewBranch(event.currentTarget.value)}
              />
              <Button
                variant="default"
                disabled={busy || status.dirty || !newBranch.trim()}
                loading={createBranchMutation.isPending}
                onClick={() => createBranchMutation.mutate(newBranch.trim())}
              >
                Create
              </Button>
            </Group>
          </SimpleGrid>
        </Stack>
      </Card>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        <Card withBorder radius="md" padding="md">
          <Stack gap="sm">
            <Group justify="space-between">
              <Text fw={600}>Working tree</Text>
              <Button
                color="red"
                variant="light"
                size="xs"
                disabled={!status.dirty || busy}
                onClick={() => setResetOpened(true)}
              >
                Discard changes
              </Button>
            </Group>
            {status.files.length === 0 ? (
              <Text c="dimmed" size="sm">
                No local changes.
              </Text>
            ) : (
              <ScrollArea.Autosize mah={260}>
                <Stack gap={4}>
                  {status.files.map((file, index) => (
                    <Group key={`${file.path}:${index}`} gap="xs" wrap="nowrap">
                      <Code>
                        {file.index}
                        {file.worktree}
                      </Code>
                      <Text size="sm" className="text-wrap">
                        {file.path}
                      </Text>
                    </Group>
                  ))}
                </Stack>
              </ScrollArea.Autosize>
            )}
            <Textarea
              label="Commit message"
              minRows={2}
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.currentTarget.value)}
            />
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput
                label="Author name"
                value={authorName}
                onChange={(event) => setAuthorName(event.currentTarget.value)}
              />
              <TextInput
                label="Author email"
                type="email"
                value={authorEmail}
                onChange={(event) => setAuthorEmail(event.currentTarget.value)}
              />
            </SimpleGrid>
            <Group justify="flex-end">
              <Button
                disabled={
                  busy ||
                  !status.dirty ||
                  !commitMessage.trim() ||
                  !validation?.valid
                }
                loading={commitMutation.isPending}
                onClick={() => commitMutation.mutate(undefined)}
              >
                Commit all portable changes
              </Button>
            </Group>
          </Stack>
        </Card>

        <Card withBorder radius="md" padding="md">
          <Stack gap="sm">
            <Text fw={600}>Diff</Text>
            {diff?.truncated && (
              <Alert color="yellow">Diff output was truncated.</Alert>
            )}
            <Tabs defaultValue="unstaged">
              <Tabs.List>
                <Tabs.Tab value="unstaged">Unstaged</Tabs.Tab>
                <Tabs.Tab value="staged">Staged</Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="unstaged" pt="sm">
                <DiffText value={diff?.unstaged ?? ""} />
              </Tabs.Panel>
              <Tabs.Panel value="staged" pt="sm">
                <DiffText value={diff?.staged ?? ""} />
              </Tabs.Panel>
            </Tabs>
          </Stack>
        </Card>
      </SimpleGrid>

      <Card withBorder radius="md" padding="md">
        <Stack gap="xs">
          <Text fw={600}>History</Text>
          {commits.map((commit) => (
            <Group
              key={commit.hash}
              justify="space-between"
              align="flex-start"
              wrap="nowrap"
            >
              <Stack gap={1}>
                <Group gap="xs">
                  <Code>{commit.shortHash}</Code>
                  <Text size="sm" fw={500}>
                    {commit.subject}
                  </Text>
                </Group>
                <Text size="xs" c="dimmed">
                  {commit.authorName} · {formatLocalDateTime(commit.authoredAt)}
                </Text>
              </Stack>
              <Button
                size="xs"
                variant="subtle"
                disabled={busy || status.dirty || commit.hash === status.head}
                onClick={() => checkoutMutation.mutate(commit.hash)}
              >
                Check out
              </Button>
            </Group>
          ))}
        </Stack>
      </Card>

      <Modal
        opened={resetOpened}
        onClose={() => setResetOpened(false)}
        title="Discard configuration changes"
        centered
      >
        <Stack gap="md">
          <Alert color="red">
            Tracked files will be reset to HEAD. Ignored files, including
            .secrets.json, are never deleted.
          </Alert>
          <Checkbox
            checked={includeUntracked}
            onChange={(event) =>
              setIncludeUntracked(event.currentTarget.checked)
            }
            label="Also delete untracked files and directories"
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setResetOpened(false)}>
              Cancel
            </Button>
            <Button
              color="red"
              loading={resetMutation.isPending}
              onClick={() => resetMutation.mutate(undefined)}
            >
              Discard changes
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

function DiffText({ value }: { value: string }) {
  return (
    <ScrollArea.Autosize mah={520}>
      <Code block>{value || "No diff."}</Code>
    </ScrollArea.Autosize>
  );
}
