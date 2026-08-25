const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

export function isWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(host);
}

export function probeReachableHost(host: string): string {
  return isWildcardHost(host) ? "127.0.0.1" : host;
}
