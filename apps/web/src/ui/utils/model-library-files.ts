import type {
  HfDownloadIntegrity,
  HfDownloadQueueJob,
  HfDownloadedRepo,
  ModelLibraryCheck,
  ModelLibraryEntry,
  ModelLibraryFile,
  ModelLibrarySnapshot,
} from "@arriero/core";

export function libraryFiles(input: {
  entry: ModelLibraryEntry | null;
  repo: HfDownloadedRepo | null;
  pinned: ModelLibrarySnapshot | null;
  latest: ModelLibrarySnapshot | null;
  source: ModelLibrarySnapshot | null;
  changes: ModelLibraryCheck["changes"];
  integrity: HfDownloadIntegrity | null;
  job: HfDownloadQueueJob | null;
}) {
  const map = <T extends { path: string }>(files: T[] | undefined) =>
    new Map(files?.map((file) => [file.path, file]));
  const pinned = map(input.pinned?.files);
  const latest = map(input.latest?.files);
  const target = map(input.source?.files);
  const local = map(input.repo?.files);
  const parts = map(input.repo?.orphanParts);
  const savedFiles = map(input.entry?.pinnedFiles);
  const baseline = map(input.entry?.snapshot?.files);
  const changes = map(input.changes);
  const verified = map(input.integrity?.files);
  const jobs = map(input.job?.files);
  const saved = new Set(input.entry?.paths);
  const paths = new Set([
    ...pinned.keys(),
    ...latest.keys(),
    ...local.keys(),
    ...parts.keys(),
    ...saved,
    ...changes.keys(),
    ...jobs.keys(),
  ]);
  return [...paths]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => {
      const remote = target.get(path) ?? null;
      const installed = local.get(path) ?? null;
      const verification = verified.get(path) ?? null;
      const orphan = parts.get(path) ?? null;
      const transfer = jobs.get(path) ?? null;
      const issue = verification
        ? verification.status !== "verified"
        : installed?.integrityFailed === true;
      const present = installed?.present ?? false;
      const partialBytes = installed?.partialBytes ?? orphan?.partialBytes ?? 0;
      const matches =
        remote && installed ? sameLibraryFile(remote, installed) : null;
      const state =
        transfer?.status === "downloading"
          ? "Downloading"
          : transfer?.status === "pending"
            ? input.job?.status === "paused"
              ? "Paused"
              : "Queued"
            : issue
              ? "Integrity issue"
              : orphan
                ? "Download leftover"
                : partialBytes > 0 && !present
                  ? "Partial"
                  : !present
                    ? input.source && !remote
                      ? "Not in this version"
                      : "Not downloaded"
                    : matches === false
                      ? "Different version"
                      : !remote && input.source
                        ? "Local only"
                        : verification?.status === "verified"
                          ? "Verified"
                          : "On disk";
      return {
        path,
        remote,
        installed,
        verification,
        orphan,
        transfer,
        issue,
        present,
        partialBytes,
        state,
        saved: saved.has(path),
        pinned: pinned.get(path) ?? savedFiles.get(path) ?? null,
        latest: latest.get(path) ?? null,
        change: changes.get(path)?.kind ?? null,
        size:
          (
            remote ??
            local.get(path) ??
            latest.get(path) ??
            pinned.get(path) ??
            savedFiles.get(path) ??
            baseline.get(path)
          )?.size ??
          orphan?.partialBytes ??
          null,
        downloadNeeded: !!remote && (!present || matches === false || issue),
        remainingBytes: remote
          ? Math.max(0, remote.size - (!present && matches ? partialBytes : 0))
          : 0,
        deleteBytes: present ? installed!.size : partialBytes,
      };
    });
}

function sameLibraryFile(a: ModelLibraryFile, b: ModelLibraryFile) {
  return a.size === b.size && (a.lfsOid ?? a.oid) === (b.lfsOid ?? b.oid);
}

export type LibraryFile = ReturnType<typeof libraryFiles>[number];
export type LibraryFolder = {
  path: string;
  name: string;
  folders: LibraryFolder[];
  files: LibraryFile[];
  descendants: LibraryFile[];
};

export function libraryFileTree(files: LibraryFile[]): LibraryFolder {
  const root: LibraryFolder = {
    path: "",
    name: "",
    folders: [],
    files: [],
    descendants: [],
  };
  const folders = new Map([["", root]]);
  for (const file of files) {
    let parent = root;
    parent.descendants.push(file);
    const segments = file.path.split("/").slice(0, -1);
    for (const name of segments) {
      const path = parent.path ? `${parent.path}/${name}` : name;
      let folder = folders.get(path);
      if (!folder) {
        folder = { path, name, folders: [], files: [], descendants: [] };
        folders.set(path, folder);
        parent.folders.push(folder);
      }
      folder.descendants.push(file);
      parent = folder;
    }
    parent.files.push(file);
  }
  return root;
}
