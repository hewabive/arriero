import { LLAMA_CPP_SOURCE_ID } from "@arriero/core";

import { sourceCheckoutProblems } from "../sources/repository.js";
import { flagValue, hasFlag } from "./cli-flags.js";
import {
  generatedHelpDiff,
  getLlamaArgumentHelpSourceSync,
  updateStoredGeneratedHelpSnapshot,
} from "./docs-source.js";
import { getEngineHelpSourceAdapter } from "./help-source-adapters.js";

async function assertPreparedCheckout(sourceId: string) {
  const problems = await sourceCheckoutProblems(sourceId);
  if (problems.length > 0) {
    throw new Error(
      `refusing --write: the ${sourceId} checkout is not prepared (${problems.join("; ")}); clone or pull it on the Source Sync page (#/source-sync)`,
    );
  }
}

async function runEngine(engineId: string) {
  const adapter = getEngineHelpSourceAdapter(engineId);
  if (hasFlag("--write")) {
    await assertPreparedCheckout(adapter.sourceId);
    console.log(JSON.stringify(await adapter.write(), null, 2));
    return;
  }
  if (hasFlag("--diff")) {
    console.log(await adapter.diff());
    return;
  }
  console.log(JSON.stringify(await adapter.sync(), null, 2));
}

async function runLlamaHelpBlock() {
  if (hasFlag("--write")) {
    await assertPreparedCheckout(LLAMA_CPP_SOURCE_ID);
    console.log(JSON.stringify(updateStoredGeneratedHelpSnapshot(), null, 2));
    return;
  }
  if (hasFlag("--diff")) {
    console.log(generatedHelpDiff());
    return;
  }
  console.log(JSON.stringify(getLlamaArgumentHelpSourceSync(), null, 2));
}

try {
  const engineId = flagValue("--engine");
  if (engineId) {
    await runEngine(engineId);
  } else {
    await runLlamaHelpBlock();
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
