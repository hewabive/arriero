import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cmakeCacheGeneratorState,
  describeRelocatedCmakeCache,
  readCmakeCacheEntry,
  relocatedCmakeCacheReason,
} from "./cmake-cache.js";

function cache(buildDir: string, sourceDir: string) {
  return [
    "# This is the CMakeCache file.",
    "CMAKE_BUILD_TYPE:STRING=Release",
    `CMAKE_CACHEFILE_DIR:INTERNAL=${buildDir}`,
    "CMAKE_CACHE_MAJOR_VERSION:INTERNAL=3",
    `CMAKE_HOME_DIRECTORY:INTERNAL=${sourceDir}`,
    "",
  ].join("\n");
}

test("reads a typed cache entry and ignores longer keys with the same prefix", () => {
  const contents = [
    "CMAKE_HOME_DIRECTORY_EXTRA:INTERNAL=/wrong",
    "CMAKE_HOME_DIRECTORY:INTERNAL=/src/llama.cpp",
  ].join("\n");

  assert.equal(
    readCmakeCacheEntry(contents, "CMAKE_HOME_DIRECTORY"),
    "/src/llama.cpp",
  );
  assert.equal(readCmakeCacheEntry(contents, "CMAKE_MISSING_KEY"), null);
});

test("accepts a cache generated for the same directories", () => {
  assert.equal(
    describeRelocatedCmakeCache(cache("/build/master", "/src/llama.cpp"), {
      buildDir: "/build/master",
      sourceDir: "/src/llama.cpp",
    }),
    null,
  );
});

test("reports a cache generated under a previous installation path", () => {
  const reason = describeRelocatedCmakeCache(
    cache("/home/user/old/builds/master", "/home/user/old/sources/llama.cpp"),
    {
      buildDir: "/home/user/new/builds/master",
      sourceDir: "/home/user/new/sources/llama.cpp",
    },
  );

  assert.ok(reason);
  assert.match(reason, /build directory \/home\/user\/old\/builds\/master/);
  assert.match(
    reason,
    /source directory \/home\/user\/old\/sources\/llama\.cpp/,
  );
});

test("treats a missing cache file as reusable", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-cmake-cache-"));
  try {
    assert.equal(relocatedCmakeCacheReason(dir, "/src/llama.cpp"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reports generator state for a build directory without a cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-cmake-cache-"));
  try {
    assert.deepEqual(cmakeCacheGeneratorState(dir), {
      exists: false,
      generator: null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reads the generator recorded in the cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-cmake-cache-"));
  try {
    writeFileSync(
      join(dir, "CMakeCache.txt"),
      "CMAKE_GENERATOR:INTERNAL=Ninja\n",
    );
    assert.deepEqual(cmakeCacheGeneratorState(dir), {
      exists: true,
      generator: "Ninja",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reports an unknown generator when the cache lacks the entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-cmake-cache-"));
  try {
    writeFileSync(join(dir, "CMakeCache.txt"), cache(dir, "/src/llama.cpp"));
    assert.deepEqual(cmakeCacheGeneratorState(dir), {
      exists: true,
      generator: null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reads the cache file from the build directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "arriero-cmake-cache-"));
  try {
    const buildDir = join(dir, "master");
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(
      join(buildDir, "CMakeCache.txt"),
      cache(join(dir, "elsewhere"), "/src/llama.cpp"),
    );

    const reason = relocatedCmakeCacheReason(buildDir, "/src/llama.cpp");
    assert.ok(reason);
    assert.match(reason, /build directory/);
    assert.doesNotMatch(reason, /source directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
