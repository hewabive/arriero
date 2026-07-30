import assert from "node:assert/strict";
import { test } from "node:test";

import { nvidiaSmiInstallCommands } from "./registry.js";

test("uses ubuntu-drivers for Ubuntu and its derivatives", () => {
  assert.deepEqual(
    nvidiaSmiInstallCommands({
      id: "ubuntu",
      idLike: ["debian"],
      prettyName: "Ubuntu 24.04 LTS",
    }),
    ["sudo ubuntu-drivers install --gpgpu", "sudo reboot"],
  );
  assert.deepEqual(
    nvidiaSmiInstallCommands({
      id: "linuxmint",
      idLike: ["ubuntu", "debian"],
      prettyName: "Linux Mint",
    }),
    ["sudo ubuntu-drivers install --gpgpu", "sudo reboot"],
  );
});

test("does not suggest Ubuntu driver commands on other distributions", () => {
  assert.deepEqual(
    nvidiaSmiInstallCommands({
      id: "debian",
      idLike: [],
      prettyName: "Debian GNU/Linux",
    }),
    [],
  );
});
