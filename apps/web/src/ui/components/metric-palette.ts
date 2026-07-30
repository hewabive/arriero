export type MetricTone =
  | "cpu"
  | "memory"
  | "gpuLoad"
  | "gpuMemory"
  | "inbound"
  | "outbound";

const LIGHT: Record<MetricTone, string> = {
  cpu: "#2a78d6",
  memory: "#1baf7a",
  gpuLoad: "#4a3aa7",
  gpuMemory: "#e87ba4",
  inbound: "#2a78d6",
  outbound: "#eb6834",
};

const DARK: Record<MetricTone, string> = {
  cpu: "#3987e5",
  memory: "#199e70",
  gpuLoad: "#9085e9",
  gpuMemory: "#d55181",
  inbound: "#3987e5",
  outbound: "#d95926",
};

export function metricToneColor(
  tone: MetricTone,
  colorScheme: "light" | "dark",
): string {
  return colorScheme === "dark" ? DARK[tone] : LIGHT[tone];
}
