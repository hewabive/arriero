import {
  classifyConfigGitPath,
  type ConfigGitCommit,
  type ConfigGitMutationResult,
  type ConfigGitStatus,
} from "@arriero/core";
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
  getConfigGitCommit,
  getConfigGitDiff,
  getConfigGitLog,
  getConfigGitStatus,
  getConfigGitValidation,
  initConfigRepository,
  pullConfigRepository,
  pushConfigRepository,
  resetConfigChanges,
  restoreConfigFiles,
  setConfigRemote,
  switchConfigBranch,
} from "../../api/client";
import { countLabel } from "../utils/plural";
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

const REPLACE_CONFIRMATION = "replace";

export function ConfigGitView() {
  const [originUrl, setOriginUrl] = useState("");
  const [cloneBranch, setCloneBranch] = useState("");
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [initBranch, setInitBranch] = useState("main");
  const [initMessage, setInitMessage] = useState("Initial configuration");
  const [newBranch, setNewBranch] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [authorEmail, setAuthorEmail] = useState("");
  const [resetOpened, setResetOpened] = useState(false);
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [originOpened, setOriginOpened] = useState(false);
  const [originDraft, setOriginDraft] = useState("");
  const [replaceOpened, setReplaceOpened] = useState(false);
  const [replaceConfirmation, setReplaceConfirmation] = useState("");
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [discardPath, setDiscardPath] = useState<string | null>(null);
  const [restoreCommit, setRestoreCommit] = useState<ConfigGitCommit | null>(
    null,
  );
  const [restorePaths, setRestorePaths] = useState<string[]>([]);
  const [showFullTree, setShowFullTree] = useState(false);

  const statusQuery = useQuery({
    queryKey: ["config-git-status"],
    queryFn: getConfigGitStatus,
    refetchInterval: 10_000,
    retry: false,
  });
  const status = statusQuery.data?.data ?? null;
  const validationQuery = useQuery({
    queryKey: ["config-git-validation"],
    queryFn: getConfigGitValidation,
    enabled: status?.isGitRepo === true,
  });
  const diffQuery = useQuery({
    queryKey: ["config-git-diff"],
    queryFn: () => getConfigGitDiff(),
    enabled: status?.isGitRepo === true,
  });
  const logQuery = useQuery({
    queryKey: ["config-git-log"],
    queryFn: () => getConfigGitLog(50),
    enabled: status?.isGitRepo === true && status.hasCommits,
  });
  const fileDiffQuery = useQuery({
    queryKey: ["config-git-diff", diffPath],
    queryFn: () => getConfigGitDiff(diffPath ?? undefined),
    enabled: status?.isGitRepo === true && diffPath !== null,
  });
  const commitDetailQuery = useQuery({
    queryKey: ["config-git-commit", restoreCommit?.hash],
    queryFn: () => getConfigGitCommit(restoreCommit?.hash ?? ""),
    enabled: restoreCommit !== null,
  });

  useEffect(() => {
    if (!status) return;
    setAuthorName((current) => current || status.authorName || "");
    setAuthorEmail((current) => current || status.authorEmail || "");
  }, [status?.authorName, status?.authorEmail]);

  const cloneMutation = useConfigMutation(
    "Configuration replaced",
    (input: {
      originUrl: string;
      branch: string | null;
      replaceExisting: boolean;
      discardUnpushed: boolean;
    }) => cloneConfigRepository(input),
    () => {
      setReplaceOpened(false);
      setReplaceConfirmation("");
    },
  );
  const initMutation = useConfigMutation(
    "Configuration repository initialized",
    (input: { branch: string; message: string }) =>
      initConfigRepository({
        branch: input.branch,
        message: input.message,
        authorName: authorName.trim() || null,
        authorEmail: authorEmail.trim() || null,
      }),
  );
  const remoteMutation = useConfigMutation(
    "Origin updated",
    (input: { originUrl: string | null }) =>
      setConfigRemote({ originUrl: input.originUrl, fetch: true }),
    () => {
      setOriginOpened(false);
      setOriginDraft("");
    },
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
  const discardFileMutation = useConfigMutation(
    "File change discarded",
    (path: string) => restoreConfigFiles({ ref: "HEAD", paths: [path] }),
    () => setDiscardPath(null),
  );
  const restoreFilesMutation = useConfigMutation(
    "Files restored",
    (input: { ref: string; paths: string[] }) => restoreConfigFiles(input),
    () => {
      setRestoreCommit(null);
      setRestorePaths([]);
      setShowFullTree(false);
    },
  );

  const mutations = [
    cloneMutation,
    initMutation,
    remoteMutation,
    fetchMutation,
    pullMutation,
    pushMutation,
    switchMutation,
    createBranchMutation,
    checkoutMutation,
    commitMutation,
    resetMutation,
    discardFileMutation,
    restoreFilesMutation,
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

  const commitDetail = commitDetailQuery.data?.data ?? null;
  const restoreCandidates = useMemo<{ path: string; status?: string }[]>(() => {
    if (!commitDetail) return [];
    if (showFullTree) return commitDetail.tree.map((path) => ({ path }));
    return commitDetail.files;
  }, [commitDetail, showFullTree]);
  const toggleRestorePath = (path: string) => {
    setRestorePaths((current) =>
      current.includes(path)
        ? current.filter((item) => item !== path)
        : [...current, path],
    );
  };

  if (!status && statusQuery.isError) {
    return (
      <Alert color="red" title="Could not load configuration repository">
        <Stack gap="sm">
          <Text size="sm">{statusQuery.error.message}</Text>
          <Group>
            <Button
              color="red"
              variant="light"
              size="xs"
              loading={statusQuery.isFetching}
              onClick={() => void statusQuery.refetch()}
            >
              Retry
            </Button>
          </Group>
        </Stack>
      </Alert>
    );
  }

  if (!status) {
    return <Text c="dimmed">Loading configuration repository…</Text>;
  }

  if (!status.isGitRepo) {
    return (
      <Stack gap="md">
        <Alert color="blue" title="Configuration is not under version control">
          Initialize keeps the current files and starts tracking them locally;
          origin can be added later. Clone discards the current files and adopts
          another repository instead — it is staged and validated first, the
          previous directory is retained as a timestamped backup, and local
          .secrets.json is preserved.
        </Alert>
        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
          <Card withBorder radius="md" padding="md">
            <Stack gap="sm">
              <Text fw={600}>Initialize locally</Text>
              <Text size="sm" c="dimmed">
                Directory: <Code>{status.configDir}</Code>
              </Text>
              <TextInput
                label="Initial branch"
                placeholder="main"
                value={initBranch}
                onChange={(event) => setInitBranch(event.currentTarget.value)}
              />
              <TextInput
                label="Initial commit message"
                value={initMessage}
                onChange={(event) => setInitMessage(event.currentTarget.value)}
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
                  onChange={(event) =>
                    setAuthorEmail(event.currentTarget.value)
                  }
                />
              </SimpleGrid>
              <Group justify="flex-end">
                <Button
                  loading={initMutation.isPending}
                  disabled={busy || !initBranch.trim() || !initMessage.trim()}
                  onClick={() =>
                    initMutation.mutate({
                      branch: initBranch.trim(),
                      message: initMessage.trim(),
                    })
                  }
                >
                  Initialize repository
                </Button>
              </Group>
            </Stack>
          </Card>

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
                label="Replace the current configuration files after validation"
              />
              <Group justify="flex-end">
                <Button
                  loading={cloneMutation.isPending}
                  disabled={busy || !originUrl.trim() || !replaceExisting}
                  onClick={() =>
                    cloneMutation.mutate({
                      originUrl: originUrl.trim(),
                      branch: cloneBranch.trim() || null,
                      replaceExisting,
                      discardUnpushed: true,
                    })
                  }
                >
                  Clone and activate
                </Button>
              </Group>
            </Stack>
          </Card>
        </SimpleGrid>
        {status.backups.length > 0 && <BackupList paths={status.backups} />}
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
              <Group gap="xs" wrap="wrap">
                <Text size="sm" c="dimmed" className="text-wrap">
                  {status.originUrl ?? "origin is not configured"}
                </Text>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  disabled={busy}
                  onClick={() => {
                    setOriginDraft(
                      status.originRedacted ? "" : (status.originUrl ?? ""),
                    );
                    setOriginOpened(true);
                  }}
                >
                  {status.originUrl ? "Change origin" : "Set origin"}
                </Button>
              </Group>
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
                    <Group
                      key={`${file.path}:${index}`}
                      gap="xs"
                      justify="space-between"
                      wrap="nowrap"
                    >
                      <Group gap="xs" wrap="nowrap">
                        <Code>
                          {file.index}
                          {file.worktree}
                        </Code>
                        <Text size="sm" className="text-wrap">
                          {file.path}
                        </Text>
                      </Group>
                      <Group gap={4} wrap="nowrap">
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          onClick={() => setDiffPath(file.path)}
                        >
                          Diff
                        </Button>
                        <Button
                          size="compact-xs"
                          color="red"
                          variant="subtle"
                          disabled={
                            busy ||
                            file.index === "?" ||
                            classifyConfigGitPath(file.path) === null
                          }
                          onClick={() => setDiscardPath(file.path)}
                        >
                          Discard
                        </Button>
                      </Group>
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
          {!status.hasCommits && (
            <Text c="dimmed" size="sm">
              The repository has no commits yet.
            </Text>
          )}
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
              <Group gap={4} wrap="nowrap">
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={busy}
                  onClick={() => {
                    setRestorePaths([]);
                    setShowFullTree(false);
                    setRestoreCommit(commit);
                  }}
                >
                  Restore files…
                </Button>
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={busy || status.dirty || commit.hash === status.head}
                  onClick={() => checkoutMutation.mutate(commit.hash)}
                >
                  Check out
                </Button>
              </Group>
            </Group>
          ))}
        </Stack>
      </Card>

      {status.backups.length > 0 && <BackupList paths={status.backups} />}

      <Card withBorder radius="md" padding="md">
        <Stack gap="sm">
          <Text fw={600} c="red">
            Danger zone
          </Text>
          <Text size="sm" c="dimmed">
            Replacing adopts another repository as the whole configuration. The
            current directory is moved aside as a timestamped backup and local
            .secrets.json is carried over.
          </Text>
          <Group justify="flex-end">
            <Button
              color="red"
              variant="light"
              disabled={busy}
              onClick={() => {
                setReplaceConfirmation("");
                setReplaceOpened(true);
              }}
            >
              Replace from repository
            </Button>
          </Group>
        </Stack>
      </Card>

      <Modal
        opened={originOpened}
        onClose={() => setOriginOpened(false)}
        title={status.originUrl ? "Change origin" : "Set origin"}
        centered
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Remote-tracking branches and upstream links of the previous origin
            are dropped. Use an SSH or credential-free HTTPS URL.
          </Text>
          {status.originRedacted && (
            <Alert color="yellow">
              The configured origin carries credentials and is only displayed
              redacted. Enter the full URL to change it; keep the secret out of
              the URL and use an SSH key or a credential helper instead.
            </Alert>
          )}
          <TextInput
            label="Origin URL"
            placeholder="git@github.com:team/llama-config.git"
            value={originDraft}
            onChange={(event) => setOriginDraft(event.currentTarget.value)}
          />
          <Group justify="space-between">
            <Button
              color="red"
              variant="subtle"
              disabled={!status.originUrl || remoteMutation.isPending}
              onClick={() => remoteMutation.mutate({ originUrl: null })}
            >
              Remove origin
            </Button>
            <Group>
              <Button variant="default" onClick={() => setOriginOpened(false)}>
                Cancel
              </Button>
              <Button
                loading={remoteMutation.isPending}
                disabled={!originDraft.trim()}
                onClick={() =>
                  remoteMutation.mutate({ originUrl: originDraft.trim() })
                }
              >
                Save origin
              </Button>
            </Group>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={replaceOpened}
        onClose={() => setReplaceOpened(false)}
        title="Replace configuration from repository"
        centered
      >
        <Stack gap="md">
          <Alert color="red">
            The current configuration repository is moved to a backup directory
            and replaced by the clone. Managed processes must be stopped first.
          </Alert>
          {(status.dirty || status.hasUnpushedCommits) && (
            <Alert color="orange" title="Local work will be discarded">
              {[
                status.dirty ? "uncommitted changes" : null,
                status.hasUnpushedCommits ? "unpushed commits" : null,
              ]
                .filter(Boolean)
                .join(" and ")}{" "}
              exist in the current configuration. Push or commit them first if
              they matter.
            </Alert>
          )}
          <TextInput
            label="Origin URL"
            placeholder="git@github.com:team/llama-config.git"
            value={originUrl}
            onChange={(event) => setOriginUrl(event.currentTarget.value)}
          />
          <TextInput
            label="Branch"
            description="Leave empty to use the origin default branch."
            placeholder="main"
            value={cloneBranch}
            onChange={(event) => setCloneBranch(event.currentTarget.value)}
          />
          <TextInput
            label={`Type ${REPLACE_CONFIRMATION} to confirm`}
            value={replaceConfirmation}
            onChange={(event) =>
              setReplaceConfirmation(event.currentTarget.value)
            }
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setReplaceOpened(false)}>
              Cancel
            </Button>
            <Button
              color="red"
              loading={cloneMutation.isPending}
              disabled={
                !originUrl.trim() ||
                replaceConfirmation.trim() !== REPLACE_CONFIRMATION
              }
              onClick={() =>
                cloneMutation.mutate({
                  originUrl: originUrl.trim(),
                  branch: cloneBranch.trim() || null,
                  replaceExisting: true,
                  discardUnpushed: true,
                })
              }
            >
              Replace configuration
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={diffPath !== null}
        onClose={() => setDiffPath(null)}
        title={diffPath ?? ""}
        size="xl"
        centered
      >
        <Stack gap="sm">
          {fileDiffQuery.data?.data.truncated && (
            <Alert color="yellow">Diff output was truncated.</Alert>
          )}
          <Tabs defaultValue="unstaged">
            <Tabs.List>
              <Tabs.Tab value="unstaged">Unstaged</Tabs.Tab>
              <Tabs.Tab value="staged">Staged</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="unstaged" pt="sm">
              <DiffText value={fileDiffQuery.data?.data.unstaged ?? ""} />
            </Tabs.Panel>
            <Tabs.Panel value="staged" pt="sm">
              <DiffText value={fileDiffQuery.data?.data.staged ?? ""} />
            </Tabs.Panel>
          </Tabs>
        </Stack>
      </Modal>

      <Modal
        opened={discardPath !== null}
        onClose={() => setDiscardPath(null)}
        title="Discard file changes"
        centered
      >
        <Stack gap="md">
          <Alert color="red">
            {discardPath} is restored to its committed content at HEAD; a
            deleted file is recreated. Uncommitted changes to this file are
            lost.
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDiscardPath(null)}>
              Cancel
            </Button>
            <Button
              color="red"
              loading={discardFileMutation.isPending}
              onClick={() => {
                if (discardPath) discardFileMutation.mutate(discardPath);
              }}
            >
              Discard file changes
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={restoreCommit !== null}
        onClose={() => setRestoreCommit(null)}
        title={
          restoreCommit ? `Restore files from ${restoreCommit.shortHash}` : ""
        }
        size="lg"
        centered
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            {restoreCommit?.subject}
          </Text>
          <Alert color="yellow">
            Restored files become uncommitted working-tree changes — review the
            diff, then commit or discard. Local uncommitted changes to the
            selected files are overwritten.
          </Alert>
          <Checkbox
            checked={showFullTree}
            onChange={(event) => setShowFullTree(event.currentTarget.checked)}
            label="Show all files at this commit"
          />
          <ScrollArea.Autosize mah={320}>
            <Stack gap={6}>
              {restoreCandidates.map((candidate) => (
                <Checkbox
                  key={candidate.path}
                  checked={restorePaths.includes(candidate.path)}
                  disabled={
                    classifyConfigGitPath(candidate.path) === null ||
                    candidate.status === "D"
                  }
                  onChange={() => toggleRestorePath(candidate.path)}
                  label={
                    <Group gap="xs" wrap="nowrap">
                      {candidate.status && <Code>{candidate.status}</Code>}
                      <Text size="sm" className="text-wrap">
                        {candidate.path}
                      </Text>
                    </Group>
                  }
                />
              ))}
              {restoreCandidates.length === 0 && (
                <Text c="dimmed" size="sm">
                  {commitDetailQuery.isPending
                    ? "Loading commit files…"
                    : "This commit changed no files; use the full-tree view."}
                </Text>
              )}
            </Stack>
          </ScrollArea.Autosize>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRestoreCommit(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy || restorePaths.length === 0}
              loading={restoreFilesMutation.isPending}
              onClick={() => {
                if (restoreCommit) {
                  restoreFilesMutation.mutate({
                    ref: restoreCommit.hash,
                    paths: restorePaths,
                  });
                }
              }}
            >
              Restore {countLabel(restorePaths.length, "file")}
            </Button>
          </Group>
        </Stack>
      </Modal>

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

function BackupList({ paths }: { paths: string[] }) {
  return (
    <Card withBorder radius="md" padding="md">
      <Stack gap={4}>
        <Text fw={600}>Replaced configuration backups</Text>
        <Text size="sm" c="dimmed">
          Left in place by earlier replacements. Remove them manually once they
          are no longer needed.
        </Text>
        {paths.map((path) => (
          <Code key={path}>{path}</Code>
        ))}
      </Stack>
    </Card>
  );
}

function DiffText({ value }: { value: string }) {
  return (
    <ScrollArea.Autosize mah={520}>
      <Code block>{value || "No diff."}</Code>
    </ScrollArea.Autosize>
  );
}
