import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { beforeEach, test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import type {
  ApiProxyRequestTrace,
  WorkloadDatasetManifest,
  WorkloadDatasetSelection,
} from "@arriero/core";

import {
  pruneApiProxyRequestFiles,
  saveApiProxyRequestFile,
} from "../proxy/request-files.js";
import {
  clearApiProxyTraceHistory,
  insertApiProxyTrace,
} from "../proxy/traces-repository.js";
import { rebuildWorkloadBody } from "./dataset-codec.js";
import {
  deleteWorkloadDataset,
  listWorkloadDatasets,
  readWorkloadDatasetBlobJson,
  readWorkloadDatasetManifest,
} from "./dataset-store.js";
import {
  WorkloadImportError,
  importWorkloadDataset,
  workloadDatasetExportStream,
} from "./dataset-transfer.js";
import {
  WorkloadSelectionError,
  currentWorkloadFreezeJob,
  previewWorkloadSelection,
  startWorkloadDatasetFreeze,
  waitForWorkloadFreeze,
} from "./freeze.js";
import { runWorkloadIndexPass } from "./indexer.js";
import { WORKLOAD_NORMALIZATION_VERSION } from "./record-analysis.js";
import { clearWorkloadRecords, writeWorkloadIndexState } from "./repository.js";

const BASE = Date.parse("2026-09-20T10:00:00.000Z");
const later = new Date(BASE + 24 * 60 * 60 * 1000);

function iso(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString();
}

const tools = [{ type: "function", function: { name: "read" } }];
const bodies = new Map<string, unknown>();

function recorded(input: {
  id: string;
  offsetMs: number;
  messages: unknown[];
  status?: number;
}): void {
  const at = iso(input.offsetMs);
  const body = {
    model: "agent",
    stream: true,
    tools,
    messages: [{ role: "system", content: "agent" }, ...input.messages],
  };
  bodies.set(input.id, body);
  const file = saveApiProxyRequestFile({
    traceId: input.id,
    traceAt: at,
    kind: "capture-request",
    label: null,
    protocol: "openai",
    endpoint: "chat.completions",
    routePath: "/v1/chat/completions",
    modelId: "agent",
    data: body,
  });
  const trace: ApiProxyRequestTrace = {
    id: input.id,
    at,
    protocol: "openai",
    translated: false,
    endpoint: "chat.completions",
    routePath: "/v1/chat/completions",
    modelId: "agent",
    sourceId: "src",
    sourceName: "agents",
    stream: true,
    targetId: "target-a",
    targetName: "a",
    slotId: null,
    cacheOrigin: null,
    cache: null,
    resumed: false,
    textReplacementCount: 0,
    routeTrace: [
      {
        kind: "capture-request",
        pipelineId: "p",
        pipelineName: "p",
        nodeId: "capture",
        nodeName: null,
        port: "next",
        detail: "request saved",
      },
    ],
    files: [file],
    schedulerActions: [],
    displacedTargetIds: [],
    usage: {
      promptTokens: 1000,
      cacheReadTokens: 800,
      cacheCreationTokens: null,
      completionTokens: 40,
      genMs: 0,
      ratePerSecond: null,
      prefillMs: null,
      promptPerSecond: null,
    },
    streamHealth: null,
    status: input.status ?? 200,
    ok: (input.status ?? 200) === 200,
    errorCode: null,
    errorMessage: null,
    translationWarnings: [],
    durationMs: 1000,
    queueMs: null,
    ttftMs: 100,
  };
  insertApiProxyTrace(trace);
}

const turn1 = [{ role: "user", content: "fix it" }];
const turn2 = [
  ...turn1,
  { role: "assistant", content: "reading" },
  { role: "user", content: "file" },
];
const turn3 = [
  ...turn2,
  { role: "assistant", content: "patching" },
  { role: "user", content: "done" },
];

const selection: WorkloadDatasetSelection = {
  windows: [{ from: iso(2000), to: iso(60_000) }],
  sourceId: null,
  modelId: null,
  targetId: null,
};

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.fromWeb(
    stream as import("node:stream/web").ReadableStream<Uint8Array>,
  )) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

function streamOf(buffer: Buffer): ReadableStream<Uint8Array> {
  return new Blob([new Uint8Array(buffer)]).stream();
}

async function freeze(): Promise<WorkloadDatasetManifest> {
  startWorkloadDatasetFreeze({
    name: "Morning window",
    description: "",
    selection,
    population: { from: iso(0), to: iso(120_000) },
  });
  await waitForWorkloadFreeze();
  const job = currentWorkloadFreezeJob();
  assert.equal(job?.status, "succeeded", job?.error ?? "");
  const manifest = readWorkloadDatasetManifest(job?.datasetId ?? "");
  assert.ok(manifest);
  return manifest;
}

beforeEach(async () => {
  clearApiProxyTraceHistory();
  clearWorkloadRecords();
  writeWorkloadIndexState({
    normalizationVersion: WORKLOAD_NORMALIZATION_VERSION,
    lastPassAt: null,
    lastPassIndexed: 0,
  });
  for (const dataset of await listWorkloadDatasets()) {
    deleteWorkloadDataset(dataset.id);
  }
  recorded({ id: "r1", offsetMs: 0, messages: turn1 });
  recorded({ id: "r2", offsetMs: 3000, messages: turn2 });
  recorded({ id: "r3", offsetMs: 9000, messages: turn3 });
  await runWorkloadIndexPass(later);
});

test("previews the segment a window yields", () => {
  const preview = previewWorkloadSelection(selection);
  assert.deepEqual(preview.problems, []);
  assert.equal(preview.records, 2);
  assert.equal(preview.segments[0]?.primed, true);
});

test("freezes a window into a dataset whose bodies rebuild exactly", async () => {
  const manifest = await freeze();
  const [segment] = manifest.content.segments;
  assert.equal(segment?.priming?.traceId, "r1");
  assert.deepEqual(
    segment?.records.map((record) => [record.traceId, record.thinkTimeMs]),
    [
      ["r2", null],
      ["r3", 5000],
    ],
  );
  assert.equal(manifest.meta.profile?.requests, 2);
  assert.equal(manifest.meta.populationProfile?.requests, 3);
  for (const record of [segment!.priming!, ...segment!.records]) {
    const blobs = new Map<string, unknown>();
    for (const hash of [...record.body.messages, record.body.tools ?? ""]) {
      if (hash) {
        blobs.set(
          hash,
          JSON.parse(await readWorkloadDatasetBlobJson(manifest.id, hash)),
        );
      }
    }
    assert.deepEqual(
      rebuildWorkloadBody(record.body, (hash) => blobs.get(hash)),
      bodies.get(record.traceId),
    );
  }
  const [listed] = await listWorkloadDatasets();
  assert.equal(listed?.records, 2);
  assert.equal(listed?.primedSegments, 1);
});

test("a repeated freeze of the same window is the same dataset", async () => {
  const first = await freeze();
  const second = await freeze();
  assert.equal(second.id, first.id);
  assert.equal((await listWorkloadDatasets()).length, 1);
});

test("export and import round-trip to another store, once", async () => {
  const manifest = await freeze();
  const exported = await collect(workloadDatasetExportStream(manifest));
  assert.ok(deleteWorkloadDataset(manifest.id));
  assert.deepEqual(await importWorkloadDataset(streamOf(exported)), {
    id: manifest.id,
    imported: true,
  });
  assert.deepEqual(readWorkloadDatasetManifest(manifest.id), manifest);
  assert.deepEqual(await importWorkloadDataset(streamOf(exported)), {
    id: manifest.id,
    imported: false,
  });
});

test("import refuses tampered and incomplete files", async () => {
  const manifest = await freeze();
  const lines = gunzipSync(await collect(workloadDatasetExportStream(manifest)))
    .toString("utf8")
    .trimEnd()
    .split("\n");
  deleteWorkloadDataset(manifest.id);
  const last = lines.at(-1) ?? "";
  const tampered = [...lines.slice(0, -1), last.replace("}", ',"x":1}')];
  await assert.rejects(
    importWorkloadDataset(streamOf(gzipSync(tampered.join("\n")))),
    WorkloadImportError,
  );
  await assert.rejects(
    importWorkloadDataset(streamOf(gzipSync(lines.slice(0, -1).join("\n")))),
    /missing 1 of/,
  );
  await assert.rejects(
    importWorkloadDataset(streamOf(Buffer.from("not gzip"))),
    WorkloadImportError,
  );
  assert.equal(readWorkloadDatasetManifest(manifest.id), null);
});

test("a frozen dataset outlives the retention of its sources", async () => {
  const manifest = await freeze();
  clearApiProxyTraceHistory();
  pruneApiProxyRequestFiles(new Date(BASE + 48 * 60 * 60 * 1000).toISOString());
  await runWorkloadIndexPass(later);
  const loaded = readWorkloadDatasetManifest(manifest.id);
  assert.deepEqual(loaded, manifest);
  const hash = manifest.content.segments[0]?.records[0]?.body.messages[0];
  assert.ok(hash);
  assert.ok(await readWorkloadDatasetBlobJson(manifest.id, hash));
});

test("refuses to freeze a window with a failed request", async () => {
  recorded({ id: "bad", offsetMs: 20_000, messages: turn1, status: 500 });
  await runWorkloadIndexPass(later);
  assert.throws(
    () =>
      startWorkloadDatasetFreeze({
        name: "Broken",
        description: "",
        selection,
        population: null,
      }),
    WorkloadSelectionError,
  );
});
