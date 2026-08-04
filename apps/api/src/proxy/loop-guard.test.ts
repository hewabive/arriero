import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ApiProxyLoopGuardConfigSchema } from "@arriero/core";
import { createApiProxyLoopGuardDetector } from "./loop-guard.js";

const defaultConfig = ApiProxyLoopGuardConfigSchema.parse({});

function fixture(name: string): string {
  return readFileSync(
    new URL(`./loop-guard-fixtures/${name}`, import.meta.url),
    "utf8",
  );
}

function feedInChunks(
  detector: ReturnType<typeof createApiProxyLoopGuardDetector>,
  lane: "answer" | "reasoning" | "tool",
  text: string,
  chunkSize = 40,
) {
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    const hit = detector.append(lane, text.slice(offset, offset + chunkSize));
    if (hit) {
      return hit;
    }
  }
  return detector.finalize();
}

test("token babble fixture triggers", () => {
  const detector = createApiProxyLoopGuardDetector(defaultConfig);
  const hit = feedInChunks(detector, "reasoning", fixture("token-babble.txt"));
  assert.ok(hit);
  assert.equal(detector.snapshot().status, "triggered");
  assert.equal(hit.lane, "reasoning");
});

test("phrase cycle fixture triggers", () => {
  const detector = createApiProxyLoopGuardDetector(defaultConfig);
  const raw = fixture("phrase-cycle.txt");
  const loopStart = raw.indexOf("---Запуск.");
  const text = raw.slice(0, loopStart) + raw.slice(loopStart).repeat(4);
  const hit = feedInChunks(detector, "answer", text);
  assert.ok(hit);
  assert.equal(detector.snapshot().status, "triggered");
});

test("template cycle fixture triggers once the enumeration repeats", () => {
  const detector = createApiProxyLoopGuardDetector(defaultConfig);
  const raw = fixture("template-cycle.txt");
  const lines = raw.split("\n").filter((line) => line.length > 0);
  const secondCycle = lines.slice(42).join("\n");
  const text = `${raw}\n${secondCycle}\n${secondCycle}`;
  const hit = feedInChunks(detector, "reasoning", text);
  assert.ok(hit);
  assert.equal(detector.snapshot().status, "triggered");
});

test("template cycle fixture alone reaches at least near-miss", () => {
  const detector = createApiProxyLoopGuardDetector(defaultConfig);
  const hit = feedInChunks(
    detector,
    "reasoning",
    fixture("template-cycle.txt"),
  );
  assert.equal(hit, null);
  const snapshot = detector.snapshot();
  assert.notEqual(snapshot.status, "clean");
  assert.ok(snapshot.peak);
  assert.ok(snapshot.peak.score >= defaultConfig.nearMissRatio);
});

test("technical prose stays clean", () => {
  const detector = createApiProxyLoopGuardDetector(defaultConfig);
  const prose = readFileSync(
    new URL("../../../../docs/API_PROXY_PIPELINES.md", import.meta.url),
    "utf8",
  );
  const hit = feedInChunks(detector, "answer", prose);
  assert.equal(hit, null);
  assert.equal(detector.snapshot().status, "clean");
});

test("structured table does not trigger", () => {
  const rows: string[] = [];
  for (let index = 0; index < 60; index += 1) {
    rows.push(
      `| model-${index} | ${(index * 37) % 100} GB | ${(index * 13) % 50} tok/s | ${index % 2 === 0 ? "resident" : "evicted"} |`,
    );
  }
  const table = `| model | size | speed | state |\n|---|---|---|---|\n${rows.join("\n")}`;
  const detector = createApiProxyLoopGuardDetector(defaultConfig);
  const hit = feedInChunks(detector, "answer", table);
  assert.equal(hit, null);
});

test("short repetition below min span stays clean", () => {
  const detector = createApiProxyLoopGuardDetector(defaultConfig);
  const hit = feedInChunks(detector, "answer", "ha ".repeat(100));
  assert.equal(hit, null);
  assert.equal(detector.snapshot().status, "clean");
});

test("lanes are independent", () => {
  const detector = createApiProxyLoopGuardDetector(defaultConfig);
  const phrase = "Проверяю состояние. Запускаю. Поехали. ";
  for (let index = 0; index < 200; index += 1) {
    detector.append(
      "answer",
      `шаг ${index * 17}: пул ${index % 7} держит ${index * 3} МиБ, задержка ${index}мс; `,
    );
    const hit = detector.append("reasoning", phrase);
    if (hit) {
      assert.equal(hit.lane, "reasoning");
      return;
    }
  }
  assert.fail("expected reasoning lane to trigger");
});

test("appends after trigger are ignored", () => {
  const detector = createApiProxyLoopGuardDetector(defaultConfig);
  const hit = feedInChunks(detector, "answer", "---Запуск.\n\n".repeat(600));
  assert.ok(hit);
  assert.equal(detector.append("answer", "ещё текст"), null);
  assert.equal(detector.finalize(), null);
  const snapshot = detector.snapshot();
  assert.equal(snapshot.status, "triggered");
  assert.ok(snapshot.trigger);
});

test("timeline and peak are recorded for calibration", () => {
  const detector = createApiProxyLoopGuardDetector(defaultConfig);
  feedInChunks(detector, "answer", "---Запуск.\n\n".repeat(600));
  const snapshot = detector.snapshot();
  assert.ok(snapshot.timeline.length > 0);
  assert.ok(snapshot.peak);
  assert.ok(snapshot.peak.tail.length > 0);
  assert.ok(snapshot.scannedChars > 0);
});
