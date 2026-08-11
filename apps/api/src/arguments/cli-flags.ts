export function hasFlag(name: string) {
  return process.argv.includes(name);
}

export function flagValue(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}
