import { readSecret, setSecret } from "../proxy/config-files.js";

const HF_TOKEN_SECRET_KEY = "hf:token";

export function getHfToken(): string | null {
  return readSecret(HF_TOKEN_SECRET_KEY);
}

export function hfTokenConfigured(): boolean {
  return getHfToken() !== null;
}

export function setHfToken(token: string | null): void {
  setSecret(HF_TOKEN_SECRET_KEY, token);
}
