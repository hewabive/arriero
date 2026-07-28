import assert from "node:assert/strict";
import test from "node:test";

import {
  comparePackageVersions,
  isPreReleaseVersion,
  looksLikeSimpleIndexUrl,
  packageIndexProjectUrl,
  parseDistributionFile,
  parseSimpleIndexHtml,
  parseSimpleIndexJson,
} from "./package-index.js";

const GITEA_PAGE = `<html><head><title>Links for vllm</title></head><body>
<h1>Links for vllm</h1>
<a href="https://gitea.local/api/packages/team/pypi/files/vllm/0.26.0/vllm-0.26.0-cp312-cp312-manylinux1_x86_64.whl#sha256=${"a".repeat(64)}" data-requires-python="&gt;=3.9">vllm-0.26.0-cp312-cp312-manylinux1_x86_64.whl</a><br>
<a href="https://gitea.local/api/packages/team/pypi/files/vllm/0.25.1/vllm-0.25.1.tar.gz#sha256=${"b".repeat(64)}">vllm-0.25.1.tar.gz</a><br>
</body></html>`;

test("Gitea simple pages parse into filenames and requires-python", () => {
  const entries = parseSimpleIndexHtml(GITEA_PAGE);
  assert.deepEqual(entries, [
    {
      filename: "vllm-0.26.0-cp312-cp312-manylinux1_x86_64.whl",
      requiresPython: ">=3.9",
    },
    { filename: "vllm-0.25.1.tar.gz", requiresPython: null },
  ]);
});

test("PEP 691 JSON pages parse into the same shape", () => {
  const entries = parseSimpleIndexJson({
    files: [
      { filename: "vllm-0.26.0-cp312-cp312-linux_x86_64.whl" },
      { filename: "vllm-0.25.0-cp312-cp312-linux_x86_64.whl", "requires-python": ">=3.10" },
      { filename: "" },
    ],
  });
  assert.deepEqual(entries, [
    { filename: "vllm-0.26.0-cp312-cp312-linux_x86_64.whl", requiresPython: null },
    {
      filename: "vllm-0.25.0-cp312-cp312-linux_x86_64.whl",
      requiresPython: ">=3.10",
    },
  ]);
});

test("wheel and sdist filenames yield version and tags", () => {
  assert.deepEqual(
    parseDistributionFile("vllm-0.26.0-cp312-cp312-manylinux1_x86_64.whl", "vllm"),
    { version: "0.26.0", pythonTag: "cp312", platformTag: "manylinux1_x86_64" },
  );
  assert.deepEqual(
    parseDistributionFile("vllm-0.26.0-1-cp312-abi3-linux_x86_64.whl", "vllm"),
    { version: "0.26.0", pythonTag: "cp312", platformTag: "linux_x86_64" },
  );
  assert.deepEqual(parseDistributionFile("vllm-0.25.1.tar.gz", "vllm"), {
    version: "0.25.1",
    pythonTag: null,
    platformTag: null,
  });
});

test("escaped distribution names still match their project", () => {
  assert.deepEqual(
    parseDistributionFile(
      "kt_kernel-0.6.3.post1-cp312-cp312-manylinux_2_28_x86_64.whl",
      "kt-kernel",
    ),
    {
      version: "0.6.3.post1",
      pythonTag: "cp312",
      platformTag: "manylinux_2_28_x86_64",
    },
  );
  assert.deepEqual(
    parseDistributionFile("kt_kernel-0.6.3.post1.tar.gz", "kt-kernel"),
    { version: "0.6.3.post1", pythonTag: null, platformTag: null },
  );
  assert.equal(parseDistributionFile("torch-2.5.0.tar.gz", "kt-kernel"), null);
});

test("versions order by PEP 440 rather than lexicographically", () => {
  const sorted = [
    "0.10.0",
    "0.9.0",
    "0.26.0rc1",
    "0.26.0",
    "0.26.0.post1",
    "0.26.0.dev1",
  ].sort(comparePackageVersions);
  assert.deepEqual(sorted, [
    "0.9.0",
    "0.10.0",
    "0.26.0.dev1",
    "0.26.0rc1",
    "0.26.0",
    "0.26.0.post1",
  ]);
});

test("the comparator is antisymmetric across stable, post and pre releases", () => {
  const versions = [
    "0.6.2",
    "0.6.2.post1",
    "0.6.2.post4",
    "0.6.3",
    "0.6.3.post1",
    "0.6.4",
    "0.10.0",
    "1.0.0rc1",
    "1.0.0",
  ];
  for (const left of versions) {
    for (const right of versions) {
      assert.equal(
        comparePackageVersions(left, right) || 0,
        -comparePackageVersions(right, left) || 0,
        `${left} vs ${right}`,
      );
    }
  }
});

test("a long stable-heavy release list sorts newest first", () => {
  const sorted = [
    "0.6.2",
    "0.6.2.post1",
    "0.6.2.post2",
    "0.6.2.post3",
    "0.6.2.post4",
    "0.6.3",
    "0.6.3.post1",
    "0.6.4",
    "0.10.0",
    "0.9.0",
  ].sort((left, right) => comparePackageVersions(right, left));
  assert.deepEqual(sorted, [
    "0.10.0",
    "0.9.0",
    "0.6.4",
    "0.6.3.post1",
    "0.6.3",
    "0.6.2.post4",
    "0.6.2.post3",
    "0.6.2.post2",
    "0.6.2.post1",
    "0.6.2",
  ]);
});

test("post releases are stable releases but pre and dev releases are not", () => {
  assert.equal(isPreReleaseVersion("0.6.3.post1"), false);
  assert.equal(isPreReleaseVersion("0.26.0"), false);
  assert.equal(isPreReleaseVersion("0.26.0rc1"), true);
  assert.equal(isPreReleaseVersion("0.26.0.dev1"), true);
});

test("project URLs normalize the distribution name onto the index root", () => {
  assert.equal(
    packageIndexProjectUrl(
      "https://gitea.local/api/packages/team/pypi/simple",
      "kt-kernel",
    ),
    "https://gitea.local/api/packages/team/pypi/simple/kt-kernel/",
  );
  assert.equal(
    packageIndexProjectUrl("https://pypi.org/simple/", "vLLM"),
    "https://pypi.org/simple/vllm/",
  );
  assert.equal(
    looksLikeSimpleIndexUrl("https://gitea.local/api/packages/team/pypi"),
    false,
  );
  assert.equal(
    looksLikeSimpleIndexUrl("https://gitea.local/api/packages/team/pypi/simple"),
    true,
  );
});
