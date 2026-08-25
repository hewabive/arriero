import { z } from "zod";

import { MemoryPoolViewSchema, ResourceLedgerSchema } from "./resources.js";
import { SystemResourcesSchema } from "./system.js";

export const FleetNodeIdSchema = z.string().regex(/^[A-Za-z0-9._-]+$/);
export const FleetNodeNameSchema = z.string().trim().min(1).max(80);
export const FleetNodeBaseUrlSchema = z.string().trim().url();

export const FleetNodeSchema = z.object({
  id: FleetNodeIdSchema,
  name: FleetNodeNameSchema,
  baseUrl: FleetNodeBaseUrlSchema,
  enabled: z.boolean().default(true),
});
export type FleetNode = z.infer<typeof FleetNodeSchema>;

export const FleetNodeCreateSchema = z.object({
  name: FleetNodeNameSchema,
  baseUrl: FleetNodeBaseUrlSchema,
  enabled: z.boolean().default(true),
  token: z.string().min(1).optional(),
});
export type FleetNodeCreate = z.infer<typeof FleetNodeCreateSchema>;

export const FleetNodeUpdateSchema = z.object({
  name: FleetNodeNameSchema.optional(),
  baseUrl: FleetNodeBaseUrlSchema.optional(),
  enabled: z.boolean().optional(),
  token: z.string().optional(),
});
export type FleetNodeUpdate = z.infer<typeof FleetNodeUpdateSchema>;

export const FleetNodeViewSchema = FleetNodeSchema.extend({
  hasToken: z.boolean(),
  self: z.boolean().default(false),
});
export type FleetNodeView = z.infer<typeof FleetNodeViewSchema>;

export const FleetSelfSchema = z.object({
  selfNodeId: FleetNodeIdSchema.nullable(),
});
export type FleetSelf = z.infer<typeof FleetSelfSchema>;

export const FleetSelfUpdateSchema = z.object({
  nodeId: FleetNodeIdSchema.nullable(),
});
export type FleetSelfUpdate = z.infer<typeof FleetSelfUpdateSchema>;

export const FederationCapabilitiesSchema = z.object({
  protocolVersion: z.number().int().positive(),
  instanceKinds: z.array(z.string().min(1)),
  creatableInstanceKinds: z.array(z.string().min(1)),
  unknownInstanceKindsTolerated: z.boolean(),
});
export type FederationCapabilities = z.infer<
  typeof FederationCapabilitiesSchema
>;

export const FleetNodeResultMetaSchema = z.object({
  nodeId: z.string(),
  nodeName: z.string(),
  self: z.boolean(),
  baseUrl: z.string().nullable(),
  ok: z.boolean(),
  error: z.string().nullable(),
});

export const FleetSystemEntrySchema = FleetNodeResultMetaSchema.extend({
  data: SystemResourcesSchema.nullable(),
});
export type FleetSystemEntry = z.infer<typeof FleetSystemEntrySchema>;

export const FleetResourcesPayloadSchema = z.object({
  pools: z.array(MemoryPoolViewSchema),
  ledger: ResourceLedgerSchema,
  detected: SystemResourcesSchema,
});
export type FleetResourcesPayload = z.infer<typeof FleetResourcesPayloadSchema>;

export const FleetResourcesEntrySchema = FleetNodeResultMetaSchema.extend({
  data: FleetResourcesPayloadSchema.nullable(),
});
export type FleetResourcesEntry = z.infer<typeof FleetResourcesEntrySchema>;
