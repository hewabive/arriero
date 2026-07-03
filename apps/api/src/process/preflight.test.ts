import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Instance } from "@llama-manager/core";

import {
  validateInstancePreflight,
  validateInstanceStartPreflight,
} from "./preflight.js";

function instance(input: Partial<Instance>): Instance {
  return {
    name: "test-instance",
    kind: input.kind ?? "llama-server",
    rpcWorkers: input.rpcWorkers ?? [],
    binaryPath: input.binaryPath ?? "/bin/sh",
    binaryPathRefId: input.binaryPathRefId ?? "test-binary",
    cwd: input.cwd ?? tmpdir(),
    args: input.args ?? {},
    env: {},
    memory: input.memory ?? [],
    status: input.status ?? "stopped",
    pid: input.pid ?? null,
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
  };
}

function writeHelpBinary(binaryPath: string, helpOutput: string) {
  writeFileSync(
    binaryPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "--help" ]; then',
      "cat <<'LLAMA_MANAGER_HELP'",
      helpOutput.trimEnd(),
      "LLAMA_MANAGER_HELP",
      "exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(binaryPath, 0o755);
}

test("validateInstancePreflight does not require a model for rpc-worker", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-manager-preflight-rpc-"));
  const binaryPath = join(dir, "rpc-server");
  try {
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binaryPath, 0o755);

    const result = validateInstancePreflight(
      instance({
        kind: "rpc-worker",
        binaryPath,
        cwd: dir,
        args: {
          "--host": "0.0.0.0",
          "--port": 50052,
          "--not-a-llama-arg": "x",
        },
      }),
    );

    assert.equal(result.ok, true);
    assert.equal(
      result.issues.some((issue) => issue.field.startsWith("args")),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInstancePreflight blocks configs without a model source", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-manager-preflight-"));
  const binaryPath = join(dir, "llama-server");
  try {
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binaryPath, 0o755);

    const result = validateInstancePreflight(
      instance({
        binaryPath,
        cwd: dir,
        args: {
          "--host": "127.0.0.1",
          "--port": 59995,
        },
      }),
    );

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.issues.find((issue) => issue.field === "args"),
      {
        level: "error",
        field: "args",
        message:
          "No --model, --models-preset, --hf-repo or --model-url is configured",
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInstancePreflight blocks registry args missing from selected binary help", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-manager-preflight-"));
  const binaryPath = join(dir, "llama-server");
  const modelPath = join(dir, "model.gguf");
  try {
    writeHelpBinary(
      binaryPath,
      `
common params:
  --model FNAME   model path
  --port PORT     server port
`,
    );
    writeFileSync(modelPath, "");

    const result = validateInstancePreflight(
      instance({
        binaryPath,
        cwd: dir,
        args: {
          "--model": modelPath,
          "--props": "{}",
        },
      }),
    );

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.issues.find((issue) => issue.field === "args.--props"),
      {
        level: "error",
        field: "args.--props",
        message:
          "Argument --props is in the canonical registry, but is not supported by the selected binary.",
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInstancePreflight blocks canonical spellings missing from selected binary help", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-manager-preflight-"));
  const binaryPath = join(dir, "llama-server");
  const modelPath = join(dir, "model.gguf");
  try {
    writeHelpBinary(
      binaryPath,
      `
common params:
  --model FNAME        model path
  --n-gpu-layers N    max. number of layers to store in VRAM
`,
    );
    writeFileSync(modelPath, "");

    const result = validateInstancePreflight(
      instance({
        binaryPath,
        cwd: dir,
        args: {
          "--model": modelPath,
          "--gpu-layers": "1",
        },
      }),
      { accelerators: [] },
    );

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.issues.find((issue) => issue.field === "args.--gpu-layers"),
      {
        level: "error",
        field: "args.--gpu-layers",
        message:
          "Argument --gpu-layers is known as --gpu-layers, but this selected binary does not expose that spelling in --help. Use one of: --n-gpu-layers.",
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInstancePreflight blocks preset-only keys in instance CLI args", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-manager-preflight-"));
  const binaryPath = join(dir, "llama-server");
  const modelPath = join(dir, "model.gguf");
  try {
    writeHelpBinary(
      binaryPath,
      `
----- common params -----
--model FNAME        model path
--port PORT          server port
`,
    );
    writeFileSync(modelPath, "");

    const result = validateInstancePreflight(
      instance({
        binaryPath,
        cwd: dir,
        args: {
          "--model": modelPath,
          "stop-timeout": 10,
        },
      }),
    );

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.issues.find((issue) => issue.field === "args.stop-timeout"),
      {
        level: "error",
        field: "args.stop-timeout",
        message:
          "Argument stop-timeout is a preset-only key and cannot be passed as a llama-server CLI argument. Put it in --models-preset instead.",
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInstancePreflight blocks empty values for value arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-manager-preflight-"));
  const binaryPath = join(dir, "llama-server");
  const modelPath = join(dir, "model.gguf");
  try {
    writeHelpBinary(
      binaryPath,
      `
common params:
  --model FNAME          model path
  --cache-type-k TYPE    KV cache key type
`,
    );
    writeFileSync(modelPath, "");

    const result = validateInstancePreflight(
      instance({
        binaryPath,
        cwd: dir,
        args: {
          "--model": modelPath,
          "--cache-type-k": "",
        },
      }),
    );

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.issues.find((issue) => issue.field === "args.--cache-type-k"),
      {
        level: "error",
        field: "args.--cache-type-k",
        message: "Argument --cache-type-k requires a value.",
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInstanceStartPreflight allows an edited instance to keep its active port", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-manager-preflight-"));
  const binaryPath = join(dir, "llama-server");
  const modelPath = join(dir, "model.gguf");
  const listener = createServer();

  try {
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binaryPath, 0o755);
    writeFileSync(modelPath, "");

    await new Promise<void>((resolve) => {
      listener.listen({ host: "127.0.0.1", port: 0 }, resolve);
    });
    const port = (listener.address() as AddressInfo).port;
    const edited = instance({
      binaryPath,
      cwd: dir,
      args: {
        "--host": "127.0.0.1",
        "--port": port,
        "--model": modelPath,
      },
    });

    const result = await validateInstanceStartPreflight(edited, {
      peers: [
        instance({
          ...edited,
          status: "running",
          pid: 12345,
        }),
      ],
      allowActiveSelfPort: true,
    });

    assert.equal(result.ok, true);
    assert.equal(
      result.issues.some((issue) => issue.field === "args.--port"),
      false,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      if (!listener.listening) {
        resolve();
        return;
      }
      listener.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInstanceStartPreflight blocks occupied host ports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-manager-preflight-"));
  const binaryPath = join(dir, "llama-server");
  const modelPath = join(dir, "model.gguf");
  const listener = createServer();

  try {
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binaryPath, 0o755);
    writeFileSync(modelPath, "");

    await new Promise<void>((resolve) => {
      listener.listen({ host: "127.0.0.1", port: 0 }, resolve);
    });
    const port = (listener.address() as AddressInfo).port;

    const result = await validateInstanceStartPreflight(
      instance({
        binaryPath,
        cwd: dir,
        args: {
          "--host": "127.0.0.1",
          "--port": port,
          "--model": modelPath,
        },
      }),
    );

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.issues.find((issue) => issue.field === "args.--port"),
      {
        level: "error",
        field: "args.--port",
        message: `Port ${port} is already in use on 127.0.0.1`,
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      if (!listener.listening) {
        resolve();
        return;
      }
      listener.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInstancePreflight warns when direct GPU layers are requested without CUDA devices", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-manager-preflight-"));
  const binaryPath = join(dir, "llama-server");
  const modelPath = join(dir, "model.gguf");
  try {
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binaryPath, 0o755);
    writeFileSync(modelPath, "");

    const result = validateInstancePreflight(
      instance({
        binaryPath,
        cwd: dir,
        args: {
          "--model": modelPath,
          "--n-gpu-layers": "auto",
        },
      }),
      { accelerators: [] },
    );

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.issues.find((issue) => issue.field === "args.--n-gpu-layers"),
      {
        level: "warning",
        field: "args.--n-gpu-layers",
        message:
          "GPU layers are requested, but no NVIDIA GPU was detected by nvidia-smi; llama.cpp will likely ignore this option.",
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInstancePreflight warns when models preset requests GPU layers without CUDA devices", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-manager-preflight-"));
  const binaryPath = join(dir, "llama-server");
  const presetPath = join(dir, "models.ini");
  try {
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binaryPath, 0o755);
    writeFileSync(
      presetPath,
      [
        "[Gemma]",
        "model = /models/gemma.gguf",
        "n-gpu-layers = auto",
        "",
        "[Qwen]",
        "model = /models/qwen.gguf",
        "gpu-layers = 0",
      ].join("\n"),
    );

    const result = validateInstancePreflight(
      instance({
        binaryPath,
        cwd: dir,
        args: {
          "--models-preset": presetPath,
        },
      }),
      { accelerators: [] },
    );

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.issues.find((issue) => issue.field === "args.--models-preset"),
      {
        level: "warning",
        field: "args.--models-preset",
        message:
          "Models preset requests GPU layers for Gemma, but no NVIDIA GPU was detected by nvidia-smi; child llama-server processes will likely ignore n-gpu-layers.",
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInstancePreflight accepts GPU layers when an NVIDIA device is visible", () => {
  const dir = mkdtempSync(join(tmpdir(), "llama-manager-preflight-"));
  const binaryPath = join(dir, "llama-server");
  const modelPath = join(dir, "model.gguf");
  try {
    writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binaryPath, 0o755);
    writeFileSync(modelPath, "");

    const result = validateInstancePreflight(
      instance({
        binaryPath,
        cwd: dir,
        args: {
          "--model": modelPath,
          "--n-gpu-layers": "auto",
        },
      }),
      {
        accelerators: [
          {
            id: "0",
            name: "NVIDIA Test GPU",
            vendor: "NVIDIA",
            kind: "gpu",
            totalMemoryBytes: null,
            availableMemoryBytes: null,
            memoryUsedRatio: null,
            utilizationPercent: null,
            temperatureC: null,
            numaNode: null,
            source: "nvidia-smi",
          },
        ],
      },
    );

    assert.equal(
      result.issues.some((issue) => issue.field === "args.--n-gpu-layers"),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
