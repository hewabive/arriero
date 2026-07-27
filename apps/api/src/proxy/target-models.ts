import { basename } from "node:path";

import {
  ApiProxyTargetModelCatalogSchema,
  type ApiEndpointRecord,
  type ApiProxyTargetModelCatalog,
  type ApiProxyTargetModelGroup,
  engineDescriptor,
  type Instance,
} from "@arriero/core";

import { listRemoteInstancesByNode } from "../nodes/remote-instances.js";
import { listApiEndpointCatalog, remoteEndpointId } from "./endpoints.js";

function stringArg(instance: Instance, key: string): string | null {
  const value = instance.args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstStringArg(instance: Instance, key: string): string | null {
  const value = instance.args[key];
  if (Array.isArray(value)) {
    return value.find((item) => item.trim())?.trim() ?? null;
  }
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isRouterInstance(instance: Instance): boolean {
  return (
    Boolean(stringArg(instance, "--models-preset")) &&
    !stringArg(instance, "--model")
  );
}

function instanceOnline(instance: Instance): boolean {
  return instance.status === "running" || instance.status === "stale";
}

function singleModelId(instance: Instance): string | null {
  if (instance.engineConfig?.type === "ktransformers") {
    const model = instance.engineConfig.model;
    const localPath =
      model.startsWith("/") ||
      model.startsWith("./") ||
      model.startsWith("../");
    return (
      instance.engineConfig.servedModelName ??
      (localPath ? basename(model) : model)
    );
  }
  if (instance.kind === "vllm") {
    return (
      firstStringArg(instance, "--served-model-name") ??
      instance.positionalArgs?.find((item) => item.trim())?.trim() ??
      null
    );
  }
  if (isRouterInstance(instance)) {
    return null;
  }
  const alias = stringArg(instance, "--alias");
  if (alias) {
    return alias;
  }
  const model = stringArg(instance, "--model");
  return model ? basename(model) : null;
}

function managedGroup(
  instance: Instance,
  remote: boolean,
  endpointId: string,
  endpointName: string,
): ApiProxyTargetModelGroup {
  const implied = singleModelId(instance);
  return {
    endpointId,
    endpointName,
    kind: "managed-instance",
    remote,
    online: instanceOnline(instance),
    modelSource: implied ? "implied" : "probe",
    impliedModel: implied,
  };
}

function externalGroup(endpoint: ApiEndpointRecord): ApiProxyTargetModelGroup {
  return {
    endpointId: endpoint.id,
    endpointName: endpoint.name,
    kind: "external-api",
    remote: false,
    online: endpoint.enabled,
    modelSource: "probe",
    impliedModel: null,
  };
}

function managerProxyGroup(
  endpoint: ApiEndpointRecord,
): ApiProxyTargetModelGroup {
  return {
    endpointId: endpoint.id,
    endpointName: endpoint.name,
    kind: "manager-proxy",
    remote: false,
    online: true,
    modelSource: "probe",
    impliedModel: null,
  };
}

export async function buildApiProxyTargetModelCatalog(
  instances: Instance[],
  options: { includeManagerProxy?: boolean } = {},
): Promise<ApiProxyTargetModelCatalog> {
  const instanceById = new Map(
    instances.map((instance) => [instance.name, instance]),
  );
  const groups: ApiProxyTargetModelGroup[] = [];

  for (const endpoint of listApiEndpointCatalog(instances)) {
    if (endpoint.kind === "manager-proxy") {
      if (options.includeManagerProxy) {
        groups.push(managerProxyGroup(endpoint));
      }
      continue;
    }
    if (endpoint.kind === "managed-instance") {
      const instance = endpoint.instanceId
        ? instanceById.get(endpoint.instanceId)
        : null;
      if (instance) {
        groups.push(managedGroup(instance, false, endpoint.id, endpoint.name));
      }
      continue;
    }
    groups.push(externalGroup(endpoint));
  }

  for (const {
    node,
    instances: nodeInstances,
  } of await listRemoteInstancesByNode()) {
    for (const instance of nodeInstances) {
      if (!engineDescriptor(instance.kind).proxy.serveEndpoint) {
        continue;
      }
      groups.push(
        managedGroup(
          instance,
          true,
          remoteEndpointId(node.id, instance.name),
          `${node.name} / ${instance.name}`,
        ),
      );
    }
  }

  return ApiProxyTargetModelCatalogSchema.parse({ groups });
}
