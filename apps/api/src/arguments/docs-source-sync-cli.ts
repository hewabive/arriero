import {
  generatedHelpDiff,
  getLlamaArgumentHelpSourceSync,
  updateStoredGeneratedHelpSnapshot,
} from "./docs-source.js";
import { getEngineHelpSourceAdapter } from "./help-source-adapters.js";

function hasFlag(name: string) {
  return process.argv.includes(name);
}

function flagValue(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

async function runEngine(engineId: string) {
  const adapter = getEngineHelpSourceAdapter(engineId);
  if (hasFlag("--write")) {
    console.log(JSON.stringify(await adapter.write(), null, 2));
    return;
  }
  if (hasFlag("--diff")) {
    console.log(await adapter.diff());
    return;
  }
  console.log(JSON.stringify(await adapter.sync(), null, 2));
}

function runLlamaHelpBlock() {
  if (hasFlag("--write")) {
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
    runLlamaHelpBlock();
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
