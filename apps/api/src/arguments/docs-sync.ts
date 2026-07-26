import {
  LlamaArgumentDocsSyncReportSchema,
  type LlamaArgumentDocsSyncReport,
} from "@llama-manager/core";

import { getLlamaSourceStatus } from "../llama/source-repository.js";
import { argumentDocsDirectory } from "./docs.js";
import { getLlamaArgumentHelpSourceSync } from "./docs-source.js";

function nowIso() {
  return new Date().toISOString();
}

export async function getLlamaArgumentDocsSyncReport(): Promise<LlamaArgumentDocsSyncReport> {
  const checkedAt = nowIso();
  const source = await getLlamaSourceStatus();
  const helpSource = getLlamaArgumentHelpSourceSync();

  return LlamaArgumentDocsSyncReportSchema.parse({
    checkedAt,
    source,
    helpSource,
    docsDirectory: argumentDocsDirectory,
  });
}
