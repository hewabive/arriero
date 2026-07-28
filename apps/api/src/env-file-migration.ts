import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const currentPrefix = "ARRIERO_";
const legacyPrefix = "LLAMA_MANAGER_";
const declarationPattern =
  /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)(?=[ \t]*=)/gm;
const legacyDeclarationPattern =
  /^([ \t]*(?:export[ \t]+)?)LLAMA_MANAGER_([A-Za-z0-9_]*)(?=[ \t]*=)/gm;

export type LegacyEnvFileMigration = {
  path: string;
  renamed: string[];
  conflicts: string[];
};

function declaredNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const match of content.matchAll(declarationPattern)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return names;
}

function writeAtomically(target: string, content: string) {
  const mode = statSync(target).mode & 0o777;
  const tmp = join(dirname(target), `.env.migrate.${process.pid}`);
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, content, { mode });
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function migrateLegacyEnvFile(
  path: string,
): LegacyEnvFileMigration | null {
  if (!existsSync(path)) {
    return null;
  }
  const target = realpathSync(path);
  const content = readFileSync(target, "utf8");
  const names = declaredNames(content);
  const legacyNames = [...names].filter((name) =>
    name.startsWith(legacyPrefix),
  );
  if (legacyNames.length === 0) {
    return null;
  }

  const renamed: string[] = [];
  const conflicts: string[] = [];
  for (const name of legacyNames) {
    const suffix = name.slice(legacyPrefix.length);
    if (names.has(`${currentPrefix}${suffix}`)) {
      conflicts.push(name);
    } else {
      renamed.push(name);
    }
  }
  if (renamed.length === 0) {
    return { path: target, renamed, conflicts };
  }

  const renamedNames = new Set(renamed);
  const next = content.replace(
    legacyDeclarationPattern,
    (match: string, lead: string, suffix: string) =>
      renamedNames.has(`${legacyPrefix}${suffix}`)
        ? `${lead}${currentPrefix}${suffix}`
        : match,
  );
  writeAtomically(target, next);
  return { path: target, renamed, conflicts };
}

export function applyLegacyEnvFileMigration(path: string) {
  let result: LegacyEnvFileMigration | null;
  try {
    result = migrateLegacyEnvFile(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.emitWarning(
      `${path}: could not rename legacy ${legacyPrefix}* entries (${reason}); they are still read as a deprecated fallback`,
    );
    return;
  }
  if (!result) {
    return;
  }
  if (result.renamed.length > 0) {
    process.emitWarning(
      `${result.path}: renamed legacy ${legacyPrefix}* entries to ${currentPrefix}* (${result.renamed.join(", ")})`,
    );
  }
  if (result.conflicts.length > 0) {
    process.emitWarning(
      `${result.path}: kept ${result.conflicts.join(", ")} because the ${currentPrefix} name is already set in the same file; delete the legacy line`,
      "DeprecationWarning",
    );
  }
}
