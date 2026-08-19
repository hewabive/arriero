import type { HfDownloadFile } from "@arriero/core";
import { ActionIcon, Group, Progress, Text, Tooltip } from "@mantine/core";
import { Check, X } from "lucide-react";

import { formatBytes, pathBaseName } from "../utils/models";

function filePercent(file: HfDownloadFile): number {
  if (file.size <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((file.downloadedBytes / file.size) * 100));
}

function fileStateLabel(file: HfDownloadFile): string {
  if (file.status === "pending") {
    return "waiting";
  }
  if (file.status === "skipped") {
    return "already on disk";
  }
  if (file.status === "canceled") {
    return file.downloadedBytes > 0
      ? `canceled · ${formatBytes(file.downloadedBytes)} kept`
      : "canceled";
  }
  if (file.status === "failed") {
    return "failed";
  }
  return formatBytes(file.size);
}

export function HfJobFileRow(props: {
  file: HfDownloadFile;
  action?:
    | { label: string; onAction: () => void; disabled?: boolean | undefined }
    | undefined;
}) {
  const { file } = props;
  const downloading = file.status === "downloading";
  return (
    <Group gap="xs" wrap="nowrap">
      {file.status === "succeeded" || file.status === "skipped" ? (
        <Check
          size={14}
          style={{ flexShrink: 0, color: "var(--mantine-color-green-6)" }}
        />
      ) : (
        <span style={{ width: 14, flexShrink: 0 }} />
      )}
      <Tooltip label={file.path} openDelay={500}>
        <Text
          size="xs"
          {...(file.status === "pending" ? { c: "dimmed" } : {})}
          style={{
            overflowWrap: "anywhere",
            flex: "0 1 auto",
            minWidth: 120,
          }}
        >
          {pathBaseName(file.path)}
        </Text>
      </Tooltip>
      {downloading && (
        <>
          <Progress
            value={filePercent(file)}
            size="sm"
            striped
            animated
            style={{ flex: "1 1 auto", minWidth: 60 }}
          />
          <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
            {formatBytes(file.downloadedBytes)} of {formatBytes(file.size)}
          </Text>
        </>
      )}
      {!downloading && <span style={{ flex: "1 1 auto" }} />}
      {!downloading && (
        <Tooltip
          label={file.error ?? ""}
          disabled={file.status !== "failed" || !file.error}
        >
          <Text
            size="xs"
            c={
              file.status === "failed"
                ? "red"
                : file.status === "canceled"
                  ? "orange"
                  : "dimmed"
            }
            style={{ whiteSpace: "nowrap" }}
          >
            {fileStateLabel(file)}
          </Text>
        </Tooltip>
      )}
      {props.action && (
        <Tooltip label={props.action.label}>
          <ActionIcon
            size="sm"
            variant="subtle"
            color="red"
            disabled={props.action.disabled ?? false}
            onClick={props.action.onAction}
            aria-label={`${props.action.label}: ${file.path}`}
          >
            <X size={14} />
          </ActionIcon>
        </Tooltip>
      )}
    </Group>
  );
}
