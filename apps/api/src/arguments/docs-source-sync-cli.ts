import {
  generatedHelpDiff,
  getLlamaArgumentHelpSourceSync,
  updateStoredGeneratedHelpSnapshot,
} from "./docs-source.js";

function hasFlag(name: string) {
  return process.argv.includes(name);
}

try {
  if (hasFlag("--write")) {
    const report = updateStoredGeneratedHelpSnapshot();
    console.log(JSON.stringify(report, null, 2));
  } else if (hasFlag("--diff")) {
    console.log(generatedHelpDiff());
  } else {
    console.log(JSON.stringify(getLlamaArgumentHelpSourceSync(), null, 2));
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
