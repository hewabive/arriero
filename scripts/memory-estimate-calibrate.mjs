import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { estimateInstanceMemory } from "../packages/core/dist/index.js";
import {
  readGgufMetadata,
  readGgufModelTensorTable,
} from "../apps/api/dist/models/gguf.js";
import { parseSplitInfo } from "../apps/api/dist/models/split.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIB = 1024 * 1024;

const CPU_CONFIGS = [
  { label: "ctx4096", args: { "--ctx-size": 4096 } },
  { label: "ctx16384", args: { "--ctx-size": 16384 } },
  {
    label: "ctx16384-q8kv",
    args: {
      "--ctx-size": 16384,
      "--cache-type-k": "q8_0",
      "--cache-type-v": "q8_0",
    },
  },
  {
    label: "ctx16384-q4kv",
    args: {
      "--ctx-size": 16384,
      "--cache-type-k": "q4_0",
      "--cache-type-v": "q4_0",
    },
  },
  {
    label: "ctx4096-ub1024",
    args: { "--ctx-size": 4096, "--ubatch-size": 1024 },
  },
];

const GPU_CONFIGS = [
  {
    label: "ngl-all-ctx4096",
    args: { "--ctx-size": 4096, "--n-gpu-layers": 999 },
  },
  {
    label: "ngl-all-ctx16384-fa",
    args: { "--ctx-size": 16384, "--n-gpu-layers": 999, "--flash-attn": "on" },
  },
  {
    label: "ngl-all-ctx16384-q8kv-fa",
    args: {
      "--ctx-size": 16384,
      "--n-gpu-layers": 999,
      "--flash-attn": "on",
      "--cache-type-k": "q8_0",
      "--cache-type-v": "q8_0",
    },
  },
];

function parseArgs(argv) {
  const options = {
    models: resolve(ROOT, "runtime/models"),
    fitParams: resolve(ROOT, "runtime/builds/master/bin/llama-fit-params"),
    gpus: 0,
    out: null,
    only: null,
    paths: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--models") options.models = argv[(index += 1)];
    else if (arg === "--fit-params") options.fitParams = argv[(index += 1)];
    else if (arg === "--gpus") options.gpus = Number(argv[(index += 1)]);
    else if (arg === "--out") options.out = argv[(index += 1)];
    else if (arg === "--only") options.only = argv[(index += 1)];
    else if (arg.endsWith(".gguf")) options.paths.push(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function collapseShards(paths) {
  return paths.filter((path) => {
    const split = parseSplitInfo(basename(path));
    return !split || split.index === 1;
  });
}

function discoverModels(options) {
  if (options.paths.length > 0) {
    return collapseShards(options.paths.map((path) => resolve(path)));
  }
  if (!existsSync(options.models)) {
    return [];
  }
  return collapseShards(
    readdirSync(options.models)
      .filter((name) => name.endsWith(".gguf"))
      .map((name) => join(options.models, name)),
  );
}

function poolsFor(options) {
  const pools = [];
  for (let index = 0; index < options.gpus; index += 1) {
    pools.push({ id: `gpu${index}`, kind: "gpu", deviceIndex: index });
  }
  pools.push({ id: "host", kind: "host" });
  return pools;
}

function hparamsOf(metadata) {
  return {
    architecture: metadata.architecture,
    blockCount: metadata.blockCount,
    embeddingLength: metadata.embeddingLength,
    headCount: metadata.headCount,
    headCountKv: metadata.headCountKv,
    attentionKeyLength: metadata.attentionKeyLength,
    attentionValueLength: metadata.attentionValueLength,
    attentionKeyLengthMla: metadata.attentionKeyLengthMla,
    attentionValueLengthMla: metadata.attentionValueLengthMla,
    causalAttention: metadata.causalAttention,
    contextLength: metadata.contextLength,
    slidingWindow: metadata.slidingWindow,
    slidingWindowPattern: metadata.slidingWindowPattern,
    sharedKvLayers: metadata.sharedKvLayers,
    ssmConvKernel: metadata.ssmConvKernel,
    ssmGroupCount: metadata.ssmGroupCount,
    ssmInnerSize: metadata.ssmInnerSize,
    ssmStateSize: metadata.ssmStateSize,
    wkvHeadSize: metadata.wkvHeadSize,
    tokenShiftCount: metadata.tokenShiftCount,
    vocabularySize: metadata.vocabularySize,
  };
}

function argsToCli(args) {
  const cli = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === "") continue;
    cli.push(key, String(value));
  }
  return cli;
}

function runFitParams(options, modelPath, args, nSeqMax) {
  const withParallel =
    "--parallel" in args || "-np" in args
      ? args
      : { ...args, "--parallel": nSeqMax };
  const cli = ["--model", modelPath, ...argsToCli(withParallel), "-fitp", "on"];
  const stdout = execFileSync(options.fitParams, cli, {
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LD_LIBRARY_PATH: dirname(options.fitParams) },
  });
  const devices = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line.trim());
    if (match) {
      devices.push({
        device: match[1],
        modelMiB: Number(match[2]),
        contextMiB: Number(match[3]),
        computeMiB: Number(match[4]),
      });
    }
  }
  const sum = (key) =>
    devices.reduce((total, device) => total + device[key], 0);
  return {
    devices,
    modelMiB: sum("modelMiB"),
    contextMiB: sum("contextMiB"),
    computeMiB: sum("computeMiB"),
  };
}

function pct(estimate, reference) {
  if (reference === 0) return estimate === 0 ? 0 : Infinity;
  return ((estimate - reference) / reference) * 100;
}

function fmtPct(value) {
  if (!Number.isFinite(value)) return "n/a";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function lastLines(text, count) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  return lines.slice(-count);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.fitParams)) {
    console.error(
      `llama-fit-params not found at ${options.fitParams}\n` +
        `Build it (it is now a non-fatal companion of the normal build) or pass --fit-params <path>.`,
    );
    process.exit(1);
  }
  const configs = [...CPU_CONFIGS, ...(options.gpus > 0 ? GPU_CONFIGS : [])];
  const pools = poolsFor(options);
  const models = discoverModels(options).filter(
    (path) => !options.only || path.includes(options.only),
  );
  if (models.length === 0) {
    console.error("no models found (use --models <dir> or pass *.gguf paths)");
    process.exit(1);
  }

  const rows = [];
  for (const modelPath of models) {
    let metadata;
    let tensors;
    try {
      metadata = readGgufMetadata(modelPath);
      tensors = readGgufModelTensorTable(modelPath);
    } catch (error) {
      console.error(`skip ${modelPath}: ${error.message}`);
      continue;
    }
    const name = modelPath.split("/").pop();
    const sizeMiB = Math.round(statSync(modelPath).size / MIB);
    for (const config of configs) {
      const estimate = estimateInstanceMemory({
        tensors,
        hparams: hparamsOf(metadata),
        args: { ...config.args },
        pools,
      });
      const analytic = {
        weightsMiB: Math.round(estimate.weightsBytesTotal / MIB),
        kvMiB: Math.round(estimate.kvBytesTotal / MIB),
        computeMiB: Math.round(estimate.computeBytesTotal / MIB),
        confidence: estimate.confidence,
        warnings: estimate.warnings,
      };
      let fit = null;
      let fitError = null;
      try {
        fit = runFitParams(
          options,
          modelPath,
          config.args,
          estimate.context.nSeqMax,
        );
      } catch (error) {
        const stderr =
          error.stderr !== undefined && error.stderr !== null
            ? String(error.stderr).trim()
            : "";
        fitError = stderr || error.message;
      }
      rows.push({
        model: name,
        fileMiB: sizeMiB,
        config: config.label,
        analytic,
        fit,
        fitError,
        delta: fit
          ? {
              weights: pct(analytic.weightsMiB, fit.modelMiB),
              kv: pct(analytic.kvMiB, fit.contextMiB),
              compute: pct(analytic.computeMiB, fit.computeMiB),
            }
          : null,
      });
    }
  }

  const header = [
    "model",
    "config",
    "A:w",
    "F:model",
    "Δw",
    "A:kv",
    "F:ctx",
    "Δkv",
    "A:comp",
    "F:comp",
    "Δcomp",
    "conf",
  ];
  const widths = header.map((cell) => cell.length);
  const lines = rows.map((row) => {
    const cells = [
      row.model.slice(0, 28),
      row.config,
      String(row.analytic.weightsMiB),
      row.fit ? String(row.fit.modelMiB) : "err",
      row.delta ? fmtPct(row.delta.weights) : "-",
      String(row.analytic.kvMiB),
      row.fit ? String(row.fit.contextMiB) : "-",
      row.delta ? fmtPct(row.delta.kv) : "-",
      String(row.analytic.computeMiB),
      row.fit ? String(row.fit.computeMiB) : "-",
      row.delta ? fmtPct(row.delta.compute) : "-",
      row.analytic.confidence,
    ];
    cells.forEach((cell, index) => {
      widths[index] = Math.max(widths[index], cell.length);
    });
    return cells;
  });
  const render = (cells) =>
    cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");
  console.log(render(header));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const cells of lines) {
    console.log(render(cells));
  }
  console.log(
    "\nLegend: A=analytic estimate, F=llama-fit-params projection (MiB). " +
      "Δ = (analytic-fit)/fit. Known gaps documented in docs/MEMORY_ESTIMATION.md.",
  );

  const errorRows = rows.filter((row) => row.fitError);
  if (errorRows.length > 0) {
    console.log("\nllama-fit-params errors:");
    const seen = new Set();
    for (const row of errorRows) {
      const tail = lastLines(row.fitError, 4);
      const signature = `${row.model}\0${tail.join("\n")}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      console.log(`  ${row.model} [${row.config}]:`);
      for (const line of tail) {
        console.log(`    ${line}`);
      }
    }
  }

  if (options.out) {
    writeFileSync(
      resolve(options.out),
      `${JSON.stringify({ generatedFrom: options.fitParams, gpus: options.gpus, rows }, null, 2)}\n`,
    );
    console.log(`\nwrote ${options.out}`);
  }
}

main();
