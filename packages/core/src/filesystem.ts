import { z } from "zod";

export const FileSystemEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["directory", "file", "other"]),
  extension: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  modifiedAt: z.string().nullable(),
  executable: z.boolean(),
  readable: z.boolean(),
});

export const FileSystemRootSchema = z.object({
  label: z.string(),
  path: z.string(),
});

export const FileSystemListResultSchema = z.object({
  path: z.string(),
  parentPath: z.string().nullable(),
  roots: z.array(FileSystemRootSchema),
  entries: z.array(FileSystemEntrySchema),
});

export type FileSystemEntry = z.infer<typeof FileSystemEntrySchema>;
export type FileSystemRoot = z.infer<typeof FileSystemRootSchema>;
export type FileSystemListResult = z.infer<typeof FileSystemListResultSchema>;
