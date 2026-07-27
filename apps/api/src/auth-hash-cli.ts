import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

import { createPasswordHash } from "./auth.js";

async function readPassword(): Promise<string> {
  const fromArg = process.argv[2];
  if (fromArg !== undefined) {
    return fromArg;
  }
  if (process.stdin.isTTY) {
    return "";
  }
  const rl = createInterface({ input: process.stdin });
  const line = await new Promise<string>((resolveLine) => {
    rl.once("line", resolveLine);
    rl.once("close", () => resolveLine(""));
  });
  rl.close();
  return line;
}

const password = (await readPassword()).trim();
if (!password) {
  process.stderr.write(
    "usage: auth:hash <password>   (or pipe the password on stdin)\n",
  );
  process.exit(1);
}

const hash = createPasswordHash(password);
const secret = randomBytes(32).toString("hex");

process.stdout.write(`${hash}\n`);
process.stderr.write(
  [
    "",
    "Add to .env (real env vars set at launch override these):",
    `  ARRIERO_ADMIN_PASSWORD_HASH=${hash}`,
    `  ARRIERO_AUTH_SECRET=${secret}`,
    "",
  ].join("\n"),
);
