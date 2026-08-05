import { z } from "zod";

export const LlamaArgumentEstimationSchema = z.enum([
  "normal",
  "exits",
  "preset-rewrite",
  "remote-selector",
  "remote-mmproj",
  "remote-draft",
  "router",
]);

export type LlamaArgumentEstimation = z.infer<
  typeof LlamaArgumentEstimationSchema
>;

export const REMOVED_LLAMA_ARGUMENT_GROUPS = [
  ["--draft", "--draft-n", "--draft-max"],
  ["--draft-min", "--draft-n-min"],
  ["--spec-ngram-size-n"],
  ["--spec-ngram-size-m"],
  ["--spec-ngram-min-hits"],
] as const;
