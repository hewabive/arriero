export function formatRate(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

export function formatPercent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(0)}%`;
}

export function formatDurationMs(value: number | null): string {
  if (value === null) return "—";
  return value >= 1000
    ? `${(value / 1000).toFixed(1)} s`
    : `${Math.round(value)} ms`;
}

export function formatTokens(value: number): string {
  return value >= 10_000
    ? `${(value / 1000).toFixed(1)}k`
    : Math.round(value).toLocaleString();
}
