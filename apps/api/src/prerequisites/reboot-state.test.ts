import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PrerequisiteRebootState } from "./reboot-state.js";

test("keeps a successful install pending for the current boot", () => {
  const directory = mkdtempSync(join(tmpdir(), "arriero-reboot-state-"));
  const path = join(directory, "state.json");
  try {
    const state = new PrerequisiteRebootState(path, () => "boot-a");
    state.markPending("nvidia-driver");
    assert.equal(state.isPending("nvidia-driver"), true);

    const reloaded = new PrerequisiteRebootState(path, () => "boot-a");
    assert.equal(reloaded.isPending("nvidia-driver"), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("clears a marker after the Linux boot ID changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "arriero-reboot-state-"));
  const path = join(directory, "state.json");
  let bootId = "boot-a";
  try {
    const state = new PrerequisiteRebootState(path, () => bootId);
    state.markPending("nvidia-driver");
    bootId = "boot-b";
    assert.equal(state.isPending("nvidia-driver"), false);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retains a marker when the boot ID is temporarily unreadable", () => {
  const directory = mkdtempSync(join(tmpdir(), "arriero-reboot-state-"));
  const path = join(directory, "state.json");
  try {
    new PrerequisiteRebootState(path, () => "boot-a").markPending(
      "nvidia-driver",
    );
    const state = new PrerequisiteRebootState(path, () => null);
    assert.equal(state.isPending("nvidia-driver"), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not create an ambiguous marker without a boot ID", () => {
  const directory = mkdtempSync(join(tmpdir(), "arriero-reboot-state-"));
  const path = join(directory, "state.json");
  try {
    const state = new PrerequisiteRebootState(path, () => null);
    assert.throws(
      () => state.markPending("nvidia-driver"),
      /boot ID is unavailable/,
    );
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
