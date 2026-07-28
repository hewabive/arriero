import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyOpensslVersion,
  meetsMinimumVersion,
  parseOpensslHeaderVersion,
} from "./openssl.js";

test("compares version triples component by component", () => {
  assert.equal(meetsMinimumVersion("3.0.13", "3.0.0"), true);
  assert.equal(meetsMinimumVersion("3.0.0", "3.0.0"), true);
  assert.equal(meetsMinimumVersion("1.1.1", "3.0.0"), false);
  assert.equal(meetsMinimumVersion("2.9.9", "3.0.0"), false);
  assert.equal(meetsMinimumVersion("10.0.0", "3.0.0"), true);
});

test("an unparseable version yields no verdict", () => {
  assert.equal(meetsMinimumVersion("unknown", "3.0.0"), null);
});

test("reads the version define from an OpenSSL 3 header", () => {
  const version = parseOpensslHeaderVersion(
    [
      "# define OPENSSL_VERSION_MAJOR  3",
      '# define OPENSSL_VERSION_STR "3.0.13"',
    ].join("\n"),
  );
  assert.equal(version, "3.0.13");
});

test("falls back to the descriptive define used by OpenSSL 1.x", () => {
  const version = parseOpensslHeaderVersion(
    '# define OPENSSL_VERSION_TEXT "OpenSSL 1.1.1f  31 Mar 2020"',
  );
  assert.equal(version, "1.1.1");
});

test("a header without any version define parses to null", () => {
  assert.equal(parseOpensslHeaderVersion("#define SOMETHING_ELSE 1"), null);
});

test("a supported version is reported as ok", () => {
  assert.deepEqual(classifyOpensslVersion("3.0.13", "openssl.pc"), {
    status: "ok",
    detail: "openssl.pc",
    version: "3.0.13",
  });
});

test("a too-old version is missing, not ok, and names the shortfall", () => {
  const result = classifyOpensslVersion("1.1.1", "openssl.pc");
  assert.equal(result.status, "missing");
  assert.equal(result.version, "1.1.1");
  assert.match(result.detail ?? "", /older than the required 3\.0\.0/);
});

test("an undeterminable version is unknown rather than assumed good", () => {
  assert.deepEqual(
    classifyOpensslVersion(null, "/usr/include/openssl/opensslv.h"),
    {
      status: "unknown",
      detail: "/usr/include/openssl/opensslv.h",
      version: null,
    },
  );
});
