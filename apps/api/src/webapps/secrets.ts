import { randomBytes } from "node:crypto";

import { readSecret, setSecret } from "../proxy/config-files.js";

function webappSecretId(name: string): string {
  return `webapp:${name}`;
}

export function webappSecretKey(name: string): string | null {
  return readSecret(webappSecretId(name));
}

export function ensureWebappSecretKey(name: string): string {
  const existing = readSecret(webappSecretId(name));
  if (existing) {
    return existing;
  }
  const created = randomBytes(32).toString("hex");
  setSecret(webappSecretId(name), created);
  return created;
}

export function renameWebappSecret(from: string, to: string): void {
  if (from === to) {
    return;
  }
  const existing = readSecret(webappSecretId(from));
  if (!existing) {
    return;
  }
  setSecret(webappSecretId(to), existing);
  setSecret(webappSecretId(from), null);
}

export function deleteWebappSecret(name: string): void {
  setSecret(webappSecretId(name), null);
}
