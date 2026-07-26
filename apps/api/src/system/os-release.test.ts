import assert from "node:assert/strict";
import { test } from "node:test";

import {
  installCommandPrefix,
  packageManagerForOsRelease,
  parseOsRelease,
} from "./os-release.js";

test("parses quoted and bare os-release values", () => {
  const release = parseOsRelease(
    [
      'PRETTY_NAME="Ubuntu 24.04.4 LTS"',
      "NAME=Ubuntu",
      "VERSION_ID=24.04",
      "ID=ubuntu",
      "ID_LIKE=debian",
      "# comment",
      "",
    ].join("\n"),
  );

  assert.equal(release.prettyName, "Ubuntu 24.04.4 LTS");
  assert.equal(release.id, "ubuntu");
  assert.deepEqual(release.idLike, ["debian"]);
});

test("falls back to NAME when PRETTY_NAME is absent", () => {
  const release = parseOsRelease("ID=arch\nNAME=Arch Linux\n");
  assert.equal(release.prettyName, "Arch Linux");
});

test("maps distributions to package managers through ID_LIKE", () => {
  assert.equal(
    packageManagerForOsRelease({
      id: "linuxmint",
      idLike: ["ubuntu", "debian"],
      prettyName: null,
    }),
    "apt",
  );
  assert.equal(
    packageManagerForOsRelease({
      id: "rocky",
      idLike: ["rhel", "centos", "fedora"],
      prettyName: null,
    }),
    "dnf",
  );
  assert.equal(
    packageManagerForOsRelease({ id: "arch", idLike: [], prettyName: null }),
    "pacman",
  );
  assert.equal(
    packageManagerForOsRelease({ id: "plan9", idLike: [], prettyName: null }),
    "unknown",
  );
});

test("unknown package manager has no install prefix", () => {
  assert.equal(installCommandPrefix("unknown"), null);
  assert.equal(installCommandPrefix("apt"), "sudo apt install -y");
});
