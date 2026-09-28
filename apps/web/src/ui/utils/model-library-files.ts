import {
  sameHfContent,
  type HfDownloadFile,
  type HfDownloadIntegrity,
  type HfDownloadQueueJob,
  type HfDownloadedRepo,
  type ModelLibraryCheck,
  type ModelLibraryEntry,
  type ModelLibrarySnapshot,
} from "@arriero/core";

export type LibraryFileState =
  | "Downloading"
  | "Paused"
  | "Queued"
  | "Integrity issue"
  | "Download leftover"
  | "Partial"
  | "Not in this version"
  | "Not downloaded"
  | "Different version"
  | "Local only"
  | "Verified"
  | "On disk";

function libraryFileState(input: {
  transfer: HfDownloadFile | null;
  jobPaused: boolean;
  issue: boolean;
  orphan: boolean;
  present: boolean;
  partialBytes: number;
  remote: boolean;
  sourceKnown: boolean;
  matches: boolean | null;
  verified: boolean;
}): LibraryFileState {
  if (input.transfer?.status === "downloading") return "Downloading";
  if (input.transfer?.status === "pending")
    return input.jobPaused ? "Paused" : "Queued";
  if (input.issue) return "Integrity issue";
  if (input.orphan) return "Download leftover";
  if (input.partialBytes > 0 && !input.present) return "Partial";
  if (!input.present)
    return input.sourceKnown && !input.remote
      ? "Not in this version"
      : "Not downloaded";
  if (input.matches === false) return "Different version";
  if (!input.remote && input.sourceKnown) return "Local only";
  return input.verified ? "Verified" : "On disk";
}

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
        remote && installed ? sameHfContent(remote, installed) : null;
      const state = libraryFileState({
        transfer,
        jobPaused: input.job?.status === "paused",
        issue,
        orphan: orphan !== null,
        present,
        partialBytes,
        remote: remote !== null,
        sourceKnown: input.source !== null,
        matches,
        verified: verification?.status === "verified",
      });
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

export type LibraryFile = ReturnType<typeof libraryFiles>[number];
export type LibraryFolder = {
  path: string;
  name: string;
  folders: LibraryFolder[];
  files: LibraryFile[];
  paths: string[];
  present: number;
  changes: number;
  bytes: number | null;
};

function libraryFolder(path: string, name: string): LibraryFolder {
  return {
    path,
    name,
    folders: [],
    files: [],
    paths: [],
    present: 0,
    changes: 0,
    bytes: 0,
  };
}

function addDescendant(folder: LibraryFolder, file: LibraryFile) {
  folder.paths.push(file.path);
  if (file.present) folder.present += 1;
  if (file.change) folder.changes += 1;
  folder.bytes =
    folder.bytes === null || file.size === null
      ? null
      : folder.bytes + file.size;
}

export function libraryFileTree(files: LibraryFile[]): LibraryFolder {
  const root = libraryFolder("", "");
  const folders = new Map([["", root]]);
  for (const file of files) {
    let parent = root;
    addDescendant(parent, file);
    const segments = file.path.split("/").slice(0, -1);
    for (const name of segments) {
      const path = parent.path ? `${parent.path}/${name}` : name;
      let folder = folders.get(path);
      if (!folder) {
        folder = libraryFolder(path, name);
        folders.set(path, folder);
        parent.folders.push(folder);
      }
      addDescendant(folder, file);
      parent = folder;
    }
    parent.files.push(file);
  }
  return root;
}
