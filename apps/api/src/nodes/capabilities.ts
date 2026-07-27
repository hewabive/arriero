import {
  INSTANCE_KINDS,
  engineDescriptor,
  type FederationCapabilities,
} from "@arriero/core";

export function localFederationCapabilities(): FederationCapabilities {
  return {
    protocolVersion: 1,
    instanceKinds: [...INSTANCE_KINDS],
    creatableInstanceKinds: INSTANCE_KINDS.filter(
      (kind) => engineDescriptor(kind).form.creatable,
    ),
    unknownInstanceKindsTolerated: true,
  };
}
