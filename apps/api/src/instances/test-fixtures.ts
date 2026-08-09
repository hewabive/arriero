import { createPathCatalogEntry } from "../path-catalog/repository.js";
import { createInstance } from "./repository.js";

export function instanceTestFixture(slug: string) {
  let counter = 0;
  let binaryRefId = "";
  const uniqueName = (prefix: string) => {
    counter += 1;
    return `${prefix}-${slug}-${counter}`;
  };
  const seedBinaryRef = () => {
    binaryRefId = createPathCatalogEntry({
      kind: "binary",
      name: uniqueName("bin"),
      path: `/opt/llama/llama-server-${slug}-${counter}`,
    }).id;
    return binaryRefId;
  };
  const seedInstance = (
    name: string,
    kind: "llama-server" | "rpc-worker" = "llama-server",
  ) =>
    createInstance({
      name,
      kind,
      rpcWorkers: [],
      binaryPathRefId: binaryRefId,
      args: {},
      env: {},
      memory: [],
    });
  return {
    uniqueName,
    seedBinaryRef,
    seedInstance,
    binaryRefId: () => binaryRefId,
  };
}
