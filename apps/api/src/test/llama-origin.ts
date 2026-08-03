import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";

export function runFixtureGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Source Test",
      GIT_AUTHOR_EMAIL: "source@example.com",
      GIT_COMMITTER_NAME: "Source Test",
      GIT_COMMITTER_EMAIL: "source@example.com",
    },
  }).trim();
}

export function createLlamaOriginRepository(name: string): string {
  const path = resolve(config.dataDir, name);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  runFixtureGit(path, ["init", "-b", "main"]);
  writeFileSync(
    resolve(path, "CMakeLists.txt"),
    "cmake_minimum_required(VERSION 3.20)\n",
  );
  writeFileSync(resolve(path, "README.md"), "test llama.cpp source\n");
  runFixtureGit(path, ["add", "."]);
  runFixtureGit(path, ["commit", "-m", "initial"]);
  return path;
}
