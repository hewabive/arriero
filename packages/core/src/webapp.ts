import { z } from "zod";

import { EnvironmentStatusSchema } from "./environments.js";
import { ProcessStopReasonSchema } from "./process.js";
import {
  WEBAPP_KINDS,
  webappDescriptor,
  type WebappKind,
} from "./webapp-descriptor.js";

export const WEBAPP_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

const WebappNameSchema = z.string().min(1).max(80).regex(WEBAPP_NAME_PATTERN);

export const WebappKindSchema = z.enum(WEBAPP_KINDS);

export const WebappHttpSchema = z.object({
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
});

export const OpenWebuiSettingsSchema = z.object({
  type: z.literal("open-webui"),
  auth: z.boolean().default(true),
  slim: z.boolean().default(true),
  defaultModels: z.array(z.string().trim().min(1)).max(50).default([]),
  extraEnv: z.record(z.string().min(1), z.string()).default({}),
});

export const ChatUiSettingsSchema = z.object({
  type: z.literal("chat-ui"),
  extraEnv: z.record(z.string().min(1), z.string()).default({}),
});

export const WebappSettingsSchema = z.discriminatedUnion("type", [
  OpenWebuiSettingsSchema,
  ChatUiSettingsSchema,
]);

export function defaultWebappSettings(
  kind: WebappKind,
): z.infer<typeof WebappSettingsSchema> {
  return WebappSettingsSchema.parse({ type: kind });
}

function validateWebappFields(
  input: {
    kind: WebappKind;
    settings: z.infer<typeof WebappSettingsSchema>;
  },
  ctx: z.RefinementCtx,
) {
  if (input.settings.type !== input.kind) {
    ctx.addIssue({
      code: "custom",
      path: ["settings", "type"],
      message: `settings type ${input.settings.type} does not match webapp kind ${input.kind}`,
    });
    return;
  }
  const reserved = new Set(webappDescriptor(input.kind).reservedEnvKeys);
  for (const key of Object.keys(input.settings.extraEnv)) {
    if (reserved.has(key)) {
      ctx.addIssue({
        code: "custom",
        path: ["settings", "extraEnv", key],
        message: `${key} is rendered by the webapp adapter`,
      });
    }
  }
}

const WebappConfigRecordBaseSchema = z.object({
  name: WebappNameSchema,
  kind: WebappKindSchema,
  envSpecId: z.string().min(1),
  http: WebappHttpSchema,
  proxySourceId: z.string().min(1).nullable().default(null),
  autostart: z.boolean().default(false),
  settings: WebappSettingsSchema,
});

export const WebappConfigRecordSchema =
  WebappConfigRecordBaseSchema.superRefine(validateWebappFields);

export const WebappCreateSchema = z
  .object({
    name: WebappNameSchema,
    kind: WebappKindSchema.default("open-webui"),
    envSpecId: z.string().min(1),
    http: WebappHttpSchema.optional(),
    autostart: z.boolean().default(false),
    settings: WebappSettingsSchema.optional(),
    createProxySource: z.boolean().default(true),
  })
  .superRefine((input, ctx) => {
    if (input.settings) {
      validateWebappFields({ kind: input.kind, settings: input.settings }, ctx);
    }
  });

export const WebappUpdateSchema = z.object({
  name: WebappNameSchema.optional(),
  envSpecId: z.string().min(1).optional(),
  http: WebappHttpSchema.optional(),
  proxySourceId: z.string().min(1).nullable().optional(),
  autostart: z.boolean().optional(),
  settings: WebappSettingsSchema.optional(),
});

export const WebappRuntimeStatusSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "stopping",
  "exited",
  "stale",
  "error",
]);

export const WebappEnvStatusSchema = z.enum([
  "missing-spec",
  ...EnvironmentStatusSchema.options,
]);

export const WebappSchema = WebappConfigRecordBaseSchema.extend({
  status: WebappRuntimeStatusSchema,
  pid: z.number().int().positive().nullable(),
  envStatus: WebappEnvStatusSchema,
  envVersion: z.string().nullable(),
  configDrift: z.boolean(),
}).superRefine(validateWebappFields);

export const WebappPreflightIssueSchema = z.object({
  level: z.enum(["error", "warning"]),
  field: z.string(),
  message: z.string(),
});

export const WebappLogTailSchema = z.object({
  name: z.string(),
  logPath: z.string().nullable(),
  rawLogPath: z.string().nullable(),
  lines: z.array(z.string()),
  truncated: z.boolean(),
});

export const WebappStopReasonSchema = ProcessStopReasonSchema.extract([
  "operator",
  "shutdown",
  "delete",
  "stale",
  "crash",
]);

export type WebappHttp = z.infer<typeof WebappHttpSchema>;
export type OpenWebuiSettings = z.infer<typeof OpenWebuiSettingsSchema>;
export type ChatUiSettings = z.infer<typeof ChatUiSettingsSchema>;
export type WebappSettings = z.infer<typeof WebappSettingsSchema>;
export type WebappConfigRecord = z.infer<typeof WebappConfigRecordSchema>;
export type WebappCreate = z.infer<typeof WebappCreateSchema>;
export type WebappUpdate = z.infer<typeof WebappUpdateSchema>;
export type WebappRuntimeStatus = z.infer<typeof WebappRuntimeStatusSchema>;
export type WebappEnvStatus = z.infer<typeof WebappEnvStatusSchema>;
export type Webapp = z.infer<typeof WebappSchema>;
export type WebappPreflightIssue = z.infer<typeof WebappPreflightIssueSchema>;
export type WebappLogTail = z.infer<typeof WebappLogTailSchema>;
export type WebappStopReason = z.infer<typeof WebappStopReasonSchema>;
