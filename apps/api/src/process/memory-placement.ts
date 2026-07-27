import type { InstanceMemoryPlacement } from "@arriero/core";

export function emptyMemoryPlacement(
  label: string,
  kind: InstanceMemoryPlacement["kind"],
): InstanceMemoryPlacement {
  return {
    label,
    kind,
    modelBytes: 0,
    contextBytes: 0,
    computeBytes: 0,
    outputBytes: 0,
    adapterBytes: 0,
    otherBytes: 0,
    totalBytes: 0,
  };
}

export function compareMemoryPlacements(
  left: InstanceMemoryPlacement,
  right: InstanceMemoryPlacement,
) {
  const order = { device: 0, host: 1, other: 2 };
  return (
    order[left.kind] - order[right.kind] ||
    left.label.localeCompare(right.label, undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );
}
