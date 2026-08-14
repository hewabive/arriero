import assert from "node:assert/strict";
import test from "node:test";

import {
  createBenchmarkPrompt,
  deleteBenchmarkPrompt,
  getBenchmarkPrompt,
  listBenchmarkPrompts,
  listBuiltinBenchmarkPrompts,
  updateBenchmarkPrompt,
} from "./prompts.js";

test("builtin prompt library covers all topics in both languages", () => {
  const prompts = listBuiltinBenchmarkPrompts();
  assert.ok(prompts.length >= 16);
  const ids = new Set(prompts.map((prompt) => prompt.id));
  assert.equal(ids.size, prompts.length);
  for (const topic of ["code", "poetry", "agentic", "rag"]) {
    for (const language of ["en", "ru"]) {
      const matching = prompts.filter(
        (prompt) => prompt.topic === topic && prompt.language === language,
      );
      assert.ok(matching.length >= 2, `${topic}/${language}`);
    }
  }
});

test("rag prompts carry long prefill", () => {
  const ragPrompts = listBuiltinBenchmarkPrompts().filter(
    (prompt) => prompt.topic === "rag",
  );
  assert.ok(ragPrompts.length >= 4);
  for (const prompt of ragPrompts) {
    assert.equal(prompt.prefillClass, "long");
    const chars = prompt.messages.reduce(
      (sum, message) => sum + message.content.length,
      0,
    );
    assert.ok(chars > 8000, `${prompt.id}: ${chars}`);
  }
});

test("custom prompt CRUD respects builtin precedence", () => {
  const created = createBenchmarkPrompt({
    title: "Custom prompt",
    topic: "code",
    language: "en",
    prefillClass: "short",
    maxTokens: 128,
    messages: [{ role: "user", content: "say hi" }],
  });
  assert.equal(getBenchmarkPrompt(created.id)?.source, "custom");
  assert.ok(listBenchmarkPrompts().some((prompt) => prompt.id === created.id));

  const updated = updateBenchmarkPrompt(created.id, {
    title: "Renamed prompt",
  });
  assert.equal(updated?.title, "Renamed prompt");

  const builtinId = listBuiltinBenchmarkPrompts()[0]?.id;
  assert.ok(builtinId);
  assert.throws(() =>
    createBenchmarkPrompt({
      id: builtinId,
      title: "Shadow",
      topic: "code",
      language: "en",
      prefillClass: "short",
      maxTokens: 128,
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.throws(() => updateBenchmarkPrompt(builtinId, { title: "x" }));
  assert.throws(() => deleteBenchmarkPrompt(builtinId));

  assert.equal(deleteBenchmarkPrompt(created.id), true);
  assert.equal(getBenchmarkPrompt(created.id), null);
  assert.equal(deleteBenchmarkPrompt(created.id), false);
});
