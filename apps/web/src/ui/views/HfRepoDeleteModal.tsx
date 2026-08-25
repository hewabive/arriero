import {
  HfDownloadDeleteBlockedSchema,
  type HfDownloadedRepo,
} from "@arriero/core";
import {
  Alert,
  Button,
  Checkbox,
  Code,
  Group,
  Modal,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";

import { ApiError, deleteHfDownload } from "../../api/client";
import { formatBytes } from "../utils/models";
import { countLabel } from "../utils/plural";

export type HfDeleteRequest = {
  paths: string[] | null;
  bytes: number;
};

function isOrphanPartPath(path: string) {
  return path.endsWith(".part") || path.endsWith(".part.json");
}

export function HfRepoDeleteModal(props: {
  repo: HfDownloadedRepo;
  request: HfDeleteRequest | null;
  onClose: () => void;
  onDeleted: (paths: string[] | null) => void;
}) {
  const { repo, request } = props;
  const queryClient = useQueryClient();
  const [verifyUpstream, setVerifyUpstream] = useState(true);
  const [removeRequirement, setRemoveRequirement] = useState(false);
  const orphanOnly =
    request !== null &&
    request.paths !== null &&
    request.paths.length > 0 &&
    request.paths.every(isOrphanPartPath);

  const deleteMutation = useMutation({
    mutationFn: deleteHfDownload,
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: ["hf-downloads"] });
      void queryClient.invalidateQueries({ queryKey: ["hf-requirements"] });
      void queryClient.invalidateQueries({ queryKey: ["models"] });
      notifications.show({
        title: input.paths ? "Files deleted" : "Download deleted",
        message: input.paths
          ? `${countLabel(input.paths.length, "file")} removed from disk.`
          : "The repository directory was removed.",
      });
      props.onDeleted(input.paths ?? null);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 412) {
        return;
      }
      notifications.show({
        color: "red",
        title: "Delete download",
        message: (error as Error).message,
      });
    },
  });

  useEffect(() => {
    if (request) {
      setVerifyUpstream(true);
      setRemoveRequirement(false);
      deleteMutation.reset();
    }
  }, [request]);

  const verifyError =
    deleteMutation.error instanceof ApiError &&
    deleteMutation.error.status === 412
      ? deleteMutation.error
      : null;
  const verifyBlockedParsed = verifyError
    ? HfDownloadDeleteBlockedSchema.safeParse(verifyError.body)
    : null;
  const blockedFiles = verifyBlockedParsed?.success
    ? verifyBlockedParsed.data.verification.files.filter(
        (file) =>
          file.status === "deleted" &&
          (request?.paths?.includes(file.path) ?? true),
      )
    : [];

  return (
    <Modal
      opened={request !== null}
      onClose={props.onClose}
      title={
        request?.paths
          ? "Delete downloaded files"
          : "Delete downloaded repository"
      }
    >
      <Stack gap="sm">
        {request?.paths ? (
          <>
            <Text size="sm">
              Delete {countLabel(request.paths.length, "file")} (
              {formatBytes(request.bytes)}) from <Code>{repo.repoId}</Code>?
              This removes the files from disk; the rest of the download stays.
            </Text>
            <Stack gap={2} mah={140} style={{ overflowY: "auto" }}>
              {request.paths.map((path) => (
                <Text key={path} size="xs" style={{ overflowWrap: "anywhere" }}>
                  {path}
                </Text>
              ))}
            </Stack>
            {request.paths.length === repo.fileCount &&
              repo.fileCount > 0 &&
              !orphanOnly && (
                <Text size="sm" c="orange">
                  Every file is selected, so the whole repository directory will
                  be removed.
                </Text>
              )}
          </>
        ) : (
          <Text size="sm">
            Delete <Code>{repo.dir}</Code> with{" "}
            {countLabel(repo.fileCount, "file")} ({formatBytes(repo.totalBytes)}
            )? This removes the files from disk.
          </Text>
        )}
        {verifyError ? (
          <Alert color="yellow" icon={<AlertTriangle size={16} />}>
            <Stack gap={4}>
              <Text size="sm">{verifyError.message}</Text>
              {blockedFiles.map((file) => (
                <Text
                  key={file.path}
                  size="xs"
                  style={{ overflowWrap: "anywhere" }}
                >
                  {file.path}
                </Text>
              ))}
            </Stack>
          </Alert>
        ) : (
          !orphanOnly && (
            <Checkbox
              checked={verifyUpstream}
              onChange={(event) =>
                setVerifyUpstream(event.currentTarget.checked)
              }
              label="Verify on Hugging Face before deleting"
              description="Blocks deletion when a file is no longer available upstream and could not be re-downloaded."
            />
          )
        )}
        {!orphanOnly && (
          <Checkbox
            checked={removeRequirement}
            onChange={(event) =>
              setRemoveRequirement(event.currentTarget.checked)
            }
            label="Also drop the model requirement"
            description="Removes the matching entry from the tracked models.json; leave off when other hosts still need the model."
          />
        )}
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            color="red"
            loading={deleteMutation.isPending}
            onClick={() => {
              if (!request) {
                return;
              }
              deleteMutation.mutate({
                dir: repo.dir,
                ...(request.paths ? { paths: request.paths } : {}),
                verifyUpstream:
                  verifyError || orphanOnly ? false : verifyUpstream,
                removeRequirement: !orphanOnly && removeRequirement,
              });
            }}
          >
            {verifyError ? "Delete anyway" : "Delete"}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
