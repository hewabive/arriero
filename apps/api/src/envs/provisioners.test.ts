import { EnvironmentSpecSchema } from "@arriero/core";
import assert from "node:assert/strict";
import test from "node:test";

import { environmentProvisioner } from "./provisioners.js";

function openWebuiSpec(source?: unknown) {
  return EnvironmentSpecSchema.parse({
    engine: "open-webui",
    version: "0.11.0",
    pythonVersion: "3.12",
    id: "open-webui-provisioner-test",
    pathCatalogEntryId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(source !== undefined ? { source } : {}),
  });
}

test("open-webui provisioner installs the pinned PyPI distribution", () => {
  const provisioner = environmentProvisioner("open-webui");
  assert.equal(provisioner.entrypointRelative, "bin/open-webui");
  assert.equal(provisioner.catalogEngineKind, null);
  assert.deepEqual(provisioner.requirements(openWebuiSpec()), [
    "open-webui==0.11.0",
  ]);
});

test("open-webui validation imports the module and pins the metadata version", () => {
  const provisioner = environmentProvisioner("open-webui");
  const command = provisioner.validationCommand(openWebuiSpec(), "/final");
  const script = command.at(-1) ?? "";
  assert.match(script, /import open_webui/);
  assert.match(script, /metadata\.version\('open-webui'\) == "0\.11\.0"/);
  assert.doesNotMatch(script, /__version__/);
});

test("open-webui availability needs no accelerator", () => {
  const provisioner = environmentProvisioner("open-webui");
  const availability = provisioner.availability(openWebuiSpec(), {
    accelerators: [],
    installed: true,
    rocmDeviceAvailable: false,
  });
  assert.deepEqual(availability, {
    availability: "usable",
    availabilityReason: null,
  });
});
