import { ActionIcon, Code, Group, Stack, Table, Text } from "@mantine/core";
import { X } from "lucide-react";
import type { LibraryFile } from "../utils/model-library-files";
import { formatBytes } from "../utils/models";

export function ModelLibraryFileDetails(props: {
  file: LibraryFile;
  pinnedKnown: boolean;
  latestKnown: boolean;
  onClose: () => void;
}) {
  const { file } = props;
  return (
    <Stack
      gap={4}
      p="sm"
      style={{
        borderTop: "1px solid var(--mantine-color-default-border)",
        maxHeight: 210,
        overflow: "auto",
      }}
    >
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm" fw={600} className="text-wrap">
          {file.path}
        </Text>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label="Close file details"
          onClick={props.onClose}
        >
          <X size={14} />
        </ActionIcon>
      </Group>
      <Table layout="fixed" fz="xs">
        <Table.Tbody>
          {(
            [
              ["Pinned", file.pinned, props.pinnedKnown],
              ["Latest checked", file.latest, props.latestKnown],
              ["Local manifest", file.installed, true],
            ] as const
          ).map(([label, metadata, known]) => (
            <Table.Tr key={label}>
              <Table.Td w={110}>{label}</Table.Td>
              <Table.Td w={90}>
                {metadata
                  ? formatBytes(metadata.size)
                  : known
                    ? "Absent"
                    : "Unknown"}
              </Table.Td>
              <Table.Td>
                <Code className="text-wrap" fz="xs">
                  {metadata ? (metadata.lfsOid ?? metadata.oid) : "—"}
                </Code>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Text size="xs" c="dimmed">
        Local presence and version matching use the download manifest. Verify
        files checks their actual contents.
      </Text>
      {file.verification && (
        <Text size="xs" c={file.issue ? "red" : "teal"}>
          Integrity: {file.verification.status}
          {file.verification.actualSize !== null &&
            ` · found ${formatBytes(file.verification.actualSize)}`}
          {file.verification.actualHash && ` · ${file.verification.actualHash}`}
          {file.verification.error && ` · ${file.verification.error}`}
        </Text>
      )}
    </Stack>
  );
}
