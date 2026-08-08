import { z } from "zod";

import { AppRunModeSchema } from "./update.js";

export const HostPackageManagerSchema = z.enum([
  "apt",
  "dnf",
  "pacman",
  "zypper",
  "apk",
  "unknown",
]);

export const PrerequisiteCheckKindSchema = z.enum([
  "executable",
  "pkg-config",
  "device",
  "capability",
]);

export const PrerequisiteSeveritySchema = z.enum(["required", "recommended"]);

export const PrerequisiteStatusSchema = z.enum([
  "ok",
  "out-of-path",
  "missing",
  "unknown",
]);

export const PrerequisiteRemediationSchema = z.object({
  packages: z.array(z.string()),
  installCommand: z.string().nullable(),
  commands: z.array(z.string()),
  includeInInstallPlan: z.boolean(),
  rebootRequired: z.boolean(),
  docPath: z.string().nullable(),
  note: z.string().nullable(),
});

export const PrerequisiteCheckSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: PrerequisiteCheckKindSchema,
  severity: PrerequisiteSeveritySchema,
  status: PrerequisiteStatusSchema,
  blocks: z.array(z.string()),
  impact: z.string(),
  detail: z.string().nullable(),
  version: z.string().nullable(),
  remediation: PrerequisiteRemediationSchema,
});

export const PrerequisiteGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  checks: z.array(PrerequisiteCheckSchema),
});

export const PrerequisiteHostSchema = z.object({
  platform: z.string(),
  osName: z.string().nullable(),
  osId: z.string().nullable(),
  packageManager: HostPackageManagerSchema,
  runMode: AppRunModeSchema,
  path: z.array(z.string()),
  autoRepairedPath: z.array(z.string()),
});

export const PrerequisiteSummarySchema = z.object({
  ok: z.number().int().nonnegative(),
  missingRequired: z.number().int().nonnegative(),
  missingRecommended: z.number().int().nonnegative(),
  outOfPath: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  unresolvedRequired: z.number().int().nonnegative(),
});

export const PrerequisiteInstallPlanSchema = z.object({
  packageManager: HostPackageManagerSchema,
  requiredCommand: z.string().nullable(),
  allCommand: z.string().nullable(),
});

export const PrerequisiteInstallCapabilitySchema = z.object({
  available: z.boolean(),
  method: z.enum(["root", "passwordless-sudo"]).nullable(),
  reason: z.string().nullable(),
});

export const PrerequisiteInstallScopeSchema = z.enum(["required", "all"]);

export const PrerequisiteInstallStartSchema = z.union([
  z.object({ scope: PrerequisiteInstallScopeSchema }),
  z.object({ checkId: z.string().min(1) }),
]);

export const PrerequisiteInstallRunStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
]);

export const PrerequisiteInstallRunSchema = z.object({
  id: z.string(),
  request: PrerequisiteInstallStartSchema,
  command: z.string(),
  status: PrerequisiteInstallRunStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  log: z.string(),
});

export const PrerequisiteReportSchema = z.object({
  checkedAt: z.string(),
  host: PrerequisiteHostSchema,
  groups: z.array(PrerequisiteGroupSchema),
  summary: PrerequisiteSummarySchema,
  install: PrerequisiteInstallPlanSchema,
  installRunner: PrerequisiteInstallCapabilitySchema,
});

export type HostPackageManager = z.infer<typeof HostPackageManagerSchema>;
export type PrerequisiteCheckKind = z.infer<typeof PrerequisiteCheckKindSchema>;
export type PrerequisiteSeverity = z.infer<typeof PrerequisiteSeveritySchema>;
export type PrerequisiteStatus = z.infer<typeof PrerequisiteStatusSchema>;
export type PrerequisiteRemediation = z.infer<
  typeof PrerequisiteRemediationSchema
>;
export type PrerequisiteCheck = z.infer<typeof PrerequisiteCheckSchema>;
export type PrerequisiteGroup = z.infer<typeof PrerequisiteGroupSchema>;
export type PrerequisiteHost = z.infer<typeof PrerequisiteHostSchema>;
export type PrerequisiteSummary = z.infer<typeof PrerequisiteSummarySchema>;
export type PrerequisiteInstallPlan = z.infer<
  typeof PrerequisiteInstallPlanSchema
>;
export type PrerequisiteInstallCapability = z.infer<
  typeof PrerequisiteInstallCapabilitySchema
>;
export type PrerequisiteInstallScope = z.infer<
  typeof PrerequisiteInstallScopeSchema
>;
export type PrerequisiteInstallStart = z.infer<
  typeof PrerequisiteInstallStartSchema
>;
export type PrerequisiteInstallRunStatus = z.infer<
  typeof PrerequisiteInstallRunStatusSchema
>;
export type PrerequisiteInstallRun = z.infer<
  typeof PrerequisiteInstallRunSchema
>;
export type PrerequisiteReport = z.infer<typeof PrerequisiteReportSchema>;
