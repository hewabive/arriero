import { z } from "zod";

export const ConfigDoctorSeveritySchema = z.enum(["error", "warning", "info"]);

export const ConfigDoctorFindingSchema = z.object({
  checkId: z.string().min(1),
  severity: ConfigDoctorSeveritySchema,
  summary: z.string().min(1),
  detail: z.string().nullable().default(null),
  configPath: z.string().nullable().default(null),
  remediation: z.string().nullable().default(null),
});

export const ConfigDoctorCheckStatusSchema = z.enum([
  "ok",
  "findings",
  "skipped",
]);

export const ConfigDoctorCheckSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: ConfigDoctorCheckStatusSchema,
  findings: z.array(ConfigDoctorFindingSchema),
});

export const ConfigDoctorSummarySchema = z.object({
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  infos: z.number().int().nonnegative(),
});

export const ConfigDoctorReportSchema = z.object({
  checkedAt: z.string(),
  checks: z.array(ConfigDoctorCheckSchema),
  summary: ConfigDoctorSummarySchema,
});

export type ConfigDoctorSeverity = z.infer<typeof ConfigDoctorSeveritySchema>;
export type ConfigDoctorFinding = z.infer<typeof ConfigDoctorFindingSchema>;
export type ConfigDoctorCheckStatus = z.infer<
  typeof ConfigDoctorCheckStatusSchema
>;
export type ConfigDoctorCheck = z.infer<typeof ConfigDoctorCheckSchema>;
export type ConfigDoctorReport = z.infer<typeof ConfigDoctorReportSchema>;
