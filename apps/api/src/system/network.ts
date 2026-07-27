import type { NetworkInterfaceAddress } from "@arriero/core";
import { networkInterfaces } from "node:os";

export function listNetworkInterfaceAddresses(): NetworkInterfaceAddress[] {
  const result: NetworkInterfaceAddress[] = [];

  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const item of addresses ?? []) {
      if (item.family !== "IPv4") {
        continue;
      }

      result.push({
        name,
        address: item.address,
        family: "IPv4",
        internal: item.internal,
        cidr: item.cidr ?? null,
        mac: item.mac || null,
      });
    }
  }

  return result.sort((left, right) => {
    if (left.internal !== right.internal) {
      return left.internal ? 1 : -1;
    }
    return `${left.name}:${left.address}`.localeCompare(
      `${right.name}:${right.address}`,
    );
  });
}
