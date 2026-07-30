import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { type BrowserContext, chromium, devices, type Page } from "playwright";

const BASE_URL = process.env.BROWSE_URL ?? "http://127.0.0.1:5173";
const BROWSER_CHANNEL = process.env.BROWSE_CHANNEL ?? "chrome";
const SERVER_FILE = "tmp/.browse-server.json";
const WS_FILE = "tmp/.browse-ws";
const URL_FILE = "tmp/.browse-url.txt";
const SCREENSHOT_DIR = "tmp/screenshots";
const SCREENSHOT_FILE = `${SCREENSHOT_DIR}/browse.png`;
const ACTION_TIMEOUT = 5_000;
const PAGE_TIMEOUT = 15_000;
const IDLE_TIMEOUT = 4 * 60 * 60_000;
const MOBILE_DEVICE = devices["iPhone 14"];

interface Action {
  ms?: number;
  selector?: string;
  type: "click" | "fill" | "hover" | "press" | "screenshot" | "select" | "wait";
  value?: string;
}

interface DaemonResult {
  error?: string;
  errors?: string[];
  logs?: string[];
  ok: boolean;
  screenshot?: string;
  title?: string;
  url?: string;
}

interface ServerInfo {
  mobile: boolean;
  pid: number;
  port: number;
}

async function doAct(actions: Action[]) {
  const server = loadServer();
  if (!server) {
    console.error("FAIL: no browser open — run: pnpm browse open [--mobile]");
    process.exit(1);
  }
  const result = await sendToServer(server.port, { actions });
  printResult(result);
}

async function doClose() {
  const server = loadServer();
  if (!server) {
    console.log("No browser open");
    return;
  }
  process.kill(server.pid, "SIGTERM");
  for (const f of [SERVER_FILE, WS_FILE])
    try {
      unlinkSync(f);
    } catch {}
  console.log(`OK: browser closed (PID: ${server.pid})`);
}

async function doGoto(path: string, actions: Action[], mobile = false) {
  const server = loadServer();
  if (server) {
    const result = await sendToServer(server.port, { actions, url: path });
    printResult(result);
    return;
  }

  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
  const errors: string[] = [];

  await withBrowser(async (_context, page) => {
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`[console] ${msg.text()}`);
    });
    page.on("pageerror", (err) => errors.push(`[error] ${err.message}`));

    await page.goto(url, { timeout: PAGE_TIMEOUT, waitUntil: "networkidle" });

    if (actions.length > 0)
      try {
        await executeActions(page, actions);
      } catch (err) {
        const msg =
          err instanceof Error ? err.message.split("\n")[0] : String(err);
        errors.push(`[action] ${msg}`);
      }

    await page.screenshot({ fullPage: true, path: SCREENSHOT_FILE });
    saveUrl(page.url());

    console.log(`OK: ${page.url()}`);
    console.log(`Title: ${await page.title()}`);
    console.log(`Screenshot: ${SCREENSHOT_FILE}`);

    if (errors.length > 0) {
      console.log(`Errors (${errors.length}):`);
      for (const err of errors) console.log(`  ${err}`);
    }
  }, mobile);
}

async function doOpen(mobile: boolean) {
  const existing = loadServer();
  if (existing) {
    console.log(
      `Browser already open (PID: ${existing.pid}, mobile: ${existing.mobile})`,
    );
    return;
  }

  spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      import.meta.filename,
      "__daemon",
      ...(mobile ? ["--mobile"] : []),
    ],
    { detached: true, stdio: "ignore" },
  ).unref();

  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const info = loadServer();
    if (info) {
      console.log(`OK: browser opened (PID: ${info.pid}, mobile: ${mobile})`);
      return;
    }
  }
  console.error("FAIL: browser did not start within 10 seconds");
  process.exit(1);
}

async function doScreenshot(mobile = false) {
  const server = loadServer();
  if (server) {
    const result = await sendToServer(server.port, {});
    printResult(result);
    return;
  }

  const url = loadUrl();
  await withBrowser(async (_context, page) => {
    await page.goto(url, { timeout: PAGE_TIMEOUT, waitUntil: "networkidle" });
    await page.screenshot({ fullPage: true, path: SCREENSHOT_FILE });
    console.log(`OK: ${url}`);
    console.log(`Screenshot: ${SCREENSHOT_FILE}`);
  }, mobile);
}

function ensureDirs() {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function executeActions(
  page: Page,
  actions: Action[],
  log: (msg: string) => void = console.log,
) {
  let shotIndex = 1;
  for (const action of actions)
    switch (action.type) {
      case "click": {
        await page.locator(action.selector!).click({ timeout: ACTION_TIMEOUT });
        await page.waitForLoadState("networkidle").catch(() => {});
        log(`OK: click "${action.selector}"`);
        break;
      }
      case "fill": {
        await page
          .locator(action.selector!)
          .fill(action.value!, { timeout: ACTION_TIMEOUT });
        log(`OK: fill "${action.selector}" = "${action.value}"`);
        break;
      }
      case "hover": {
        await page.locator(action.selector!).hover({ timeout: ACTION_TIMEOUT });
        log(`OK: hover "${action.selector}"`);
        break;
      }
      case "press": {
        await page.keyboard.press(action.value!);
        log(`OK: press "${action.value}"`);
        break;
      }
      case "screenshot": {
        const path = `${SCREENSHOT_DIR}/browse-${shotIndex++}.png`;
        await page.screenshot({ fullPage: true, path });
        log(`Screenshot: ${path}`);
        break;
      }
      case "select": {
        await page
          .locator(action.selector!)
          .selectOption(action.value!, { timeout: ACTION_TIMEOUT });
        log(`OK: select "${action.selector}" = "${action.value}"`);
        break;
      }
      case "wait": {
        await page.waitForTimeout(action.ms!);
        log(`OK: wait ${action.ms}ms`);
        break;
      }
    }
}

function loadServer(): ServerInfo | null {
  if (!existsSync(SERVER_FILE)) return null;
  try {
    const info: ServerInfo = JSON.parse(readFileSync(SERVER_FILE, "utf8"));
    process.kill(info.pid, 0);
    return info;
  } catch {
    for (const f of [SERVER_FILE, WS_FILE])
      try {
        unlinkSync(f);
      } catch {}
    return null;
  }
}

function loadUrl(): string {
  if (existsSync(URL_FILE)) return readFileSync(URL_FILE, "utf8").trim();
  return BASE_URL;
}

function parseActions(args: string[]): Action[] {
  const actions: Action[] = [];
  let i = 0;
  while (i < args.length)
    switch (args[i]) {
      case "--click": {
        actions.push({ selector: args[i + 1], type: "click" });
        i += 2;
        break;
      }
      case "--fill": {
        actions.push({
          selector: args[i + 1],
          type: "fill",
          value: args[i + 2],
        });
        i += 3;
        break;
      }
      case "--hover": {
        actions.push({ selector: args[i + 1], type: "hover" });
        i += 2;
        break;
      }
      case "--press": {
        actions.push({ type: "press", value: args[i + 1] });
        i += 2;
        break;
      }
      case "--select": {
        actions.push({
          selector: args[i + 1],
          type: "select",
          value: args[i + 2],
        });
        i += 3;
        break;
      }
      case "--shot": {
        actions.push({ type: "screenshot" });
        i += 1;
        break;
      }
      case "--wait": {
        actions.push({ ms: parseInt(args[i + 1]), type: "wait" });
        i += 2;
        break;
      }
      default: {
        i++;
      }
    }

  return actions;
}

function printResult(result: DaemonResult) {
  if (!result.ok) {
    console.error(`FAIL: ${result.error}`);
    process.exit(1);
  }
  for (const log of result.logs ?? []) console.log(log);
  console.log(`OK: ${result.url}`);
  console.log(`Title: ${result.title}`);
  console.log(`Screenshot: ${result.screenshot}`);
  if (result.errors?.length) {
    console.log(`Errors (${result.errors.length}):`);
    for (const err of result.errors) console.log(`  ${err}`);
  }
}

async function runDaemon(mobile: boolean) {
  const browserServer = await chromium.launchServer(browserLaunchOptions());
  writeFileSync(WS_FILE, browserServer.wsEndpoint());
  const browser = await chromium.connect(browserServer.wsEndpoint());
  const context = await browser.newContext(mobile ? MOBILE_DEVICE : {});
  const page = await context.newPage();
  let httpServer: ReturnType<typeof createServer>;

  const cleanup = async () => {
    try {
      await browser.close();
    } catch {}
    try {
      await browserServer.close();
    } catch {}
    httpServer?.close();
    for (const f of [SERVER_FILE, WS_FILE])
      try {
        unlinkSync(f);
      } catch {}
    process.exit(0);
  };

  let idleTimer = setTimeout(() => void cleanup(), IDLE_TIMEOUT);
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void cleanup(), IDLE_TIMEOUT);
  };

  httpServer = createServer(async (_req: IncomingMessage, res) => {
    resetIdle();
    if (_req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    const body = await new Promise<string>((resolve) => {
      let data = "";
      _req.on("data", (chunk: Buffer) => {
        data += chunk;
      });
      _req.on("end", () => resolve(data));
    });

    const errors: string[] = [];
    const logs: string[] = [];
    const log = (msg: string) => logs.push(msg);

    page.removeAllListeners("console");
    page.removeAllListeners("pageerror");
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`[console] ${msg.text()}`);
    });
    page.on("pageerror", (err) => errors.push(`[error] ${err.message}`));

    try {
      const cmd = JSON.parse(body);

      if (cmd.url) {
        const url = cmd.url.startsWith("http")
          ? cmd.url
          : `${BASE_URL}${cmd.url}`;
        await page.goto(url, {
          timeout: PAGE_TIMEOUT,
          waitUntil: "networkidle",
        });
      }

      if (cmd.actions?.length > 0)
        try {
          await executeActions(page, cmd.actions, log);
        } catch (err) {
          const msg =
            err instanceof Error ? err.message.split("\n")[0] : String(err);
          errors.push(`[action] ${msg}`);
        }

      await page.screenshot({ fullPage: true, path: SCREENSHOT_FILE });
      saveUrl(page.url());

      const result: DaemonResult = {
        ...(errors.length > 0 ? { errors } : {}),
        logs,
        ok: true,
        screenshot: SCREENSHOT_FILE,
        title: await page.title(),
        url: page.url(),
      };
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(result));
    } catch (err) {
      const msg =
        err instanceof Error ? err.message.split("\n")[0] : String(err);
      res
        .writeHead(500, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: msg, ok: false }));
    }
  });

  httpServer.listen(0, () => {
    const { port } = httpServer.address() as AddressInfo;
    writeFileSync(
      SERVER_FILE,
      JSON.stringify({ mobile, pid: process.pid, port }),
    );
  });

  process.on("SIGTERM", () => void cleanup());
  process.on("SIGINT", () => void cleanup());
}

function saveUrl(url: string) {
  writeFileSync(URL_FILE, url);
}

async function sendToServer(port: number, body: object): Promise<DaemonResult> {
  const res = await fetch(`http://localhost:${port}/`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return res.json() as Promise<DaemonResult>;
}

async function withBrowser(
  fn: (context: BrowserContext, page: Page) => Promise<void>,
  mobile = false,
) {
  const browser = await chromium.launch(browserLaunchOptions());
  const context = await browser.newContext(mobile ? MOBILE_DEVICE : {});
  const page = await context.newPage();

  try {
    await fn(context, page);
  } finally {
    await browser.close();
  }
}

function browserLaunchOptions() {
  if (BROWSER_CHANNEL === "playwright") return { headless: true };
  return { channel: BROWSER_CHANNEL, headless: true };
}

ensureDirs();

const args = process.argv.slice(2);
const command = args[0];
const mobile = args.includes("--mobile");

switch (command) {
  case "__daemon": {
    await runDaemon(mobile);
    break;
  }
  case "act": {
    await doAct(parseActions(args.slice(1)));
    break;
  }
  case "close": {
    await doClose();
    break;
  }
  case "goto": {
    await doGoto(args[1], parseActions(args.slice(2)), mobile);
    break;
  }
  case "open": {
    await doOpen(mobile);
    break;
  }
  case "screenshot": {
    await doScreenshot(mobile);
    break;
  }
  default: {
    console.log(`Usage: pnpm browse <command> [--mobile]

Persistent browser:
  open [--mobile]    Start persistent browser (state preserved between commands)
  close              Stop persistent browser

Navigation:
  goto <path> [actions]  Navigate to URL (hash route, e.g. /#/instances)
  act [actions]          Act on current page without navigating (requires open)
  screenshot             Re-screenshot current page

Actions (for goto/act):
  --click <sel>      Click element, wait for network idle
  --fill <sel> <val> Fill input/textarea
  --hover <sel>      Hover element
  --press <key>      Press keyboard key
  --select <sel> <val> Select option
  --shot             Intermediate screenshot
  --wait <ms>        Wait milliseconds

Global flags:
  --mobile           Emulate mobile device (iPhone 14: 390x844)

Base URL: ${BASE_URL} (override with BROWSE_URL).
Browser channel: ${BROWSER_CHANNEL} (override with BROWSE_CHANNEL; use "playwright" for bundled Chromium).
When persistent browser is open, goto/screenshot use it automatically.
Without persistent browser, each command launches a fresh browser.`);
    process.exit(command ? 1 : 0);
  }
}
