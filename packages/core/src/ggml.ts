import { z } from "zod";

export type GgmlTypeTrait = {
  id: number;
  name: string;
  blockSize: number;
  typeSize: number;
};

const TRAITS: GgmlTypeTrait[] = [
  { id: 0, name: "f32", blockSize: 1, typeSize: 4 },
  { id: 1, name: "f16", blockSize: 1, typeSize: 2 },
  { id: 2, name: "q4_0", blockSize: 32, typeSize: 18 },
  { id: 3, name: "q4_1", blockSize: 32, typeSize: 20 },
  { id: 6, name: "q5_0", blockSize: 32, typeSize: 22 },
  { id: 7, name: "q5_1", blockSize: 32, typeSize: 24 },
  { id: 8, name: "q8_0", blockSize: 32, typeSize: 34 },
  { id: 9, name: "q8_1", blockSize: 32, typeSize: 36 },
  { id: 10, name: "q2_K", blockSize: 256, typeSize: 84 },
  { id: 11, name: "q3_K", blockSize: 256, typeSize: 110 },
  { id: 12, name: "q4_K", blockSize: 256, typeSize: 144 },
  { id: 13, name: "q5_K", blockSize: 256, typeSize: 176 },
  { id: 14, name: "q6_K", blockSize: 256, typeSize: 210 },
  { id: 15, name: "q8_K", blockSize: 256, typeSize: 292 },
  { id: 16, name: "iq2_xxs", blockSize: 256, typeSize: 66 },
  { id: 17, name: "iq2_xs", blockSize: 256, typeSize: 74 },
  { id: 18, name: "iq3_xxs", blockSize: 256, typeSize: 98 },
  { id: 19, name: "iq1_s", blockSize: 256, typeSize: 50 },
  { id: 20, name: "iq4_nl", blockSize: 32, typeSize: 18 },
  { id: 21, name: "iq3_s", blockSize: 256, typeSize: 110 },
  { id: 22, name: "iq2_s", blockSize: 256, typeSize: 82 },
  { id: 23, name: "iq4_xs", blockSize: 256, typeSize: 136 },
  { id: 24, name: "i8", blockSize: 1, typeSize: 1 },
  { id: 25, name: "i16", blockSize: 1, typeSize: 2 },
  { id: 26, name: "i32", blockSize: 1, typeSize: 4 },
  { id: 27, name: "i64", blockSize: 1, typeSize: 8 },
  { id: 28, name: "f64", blockSize: 1, typeSize: 8 },
  { id: 29, name: "iq1_m", blockSize: 256, typeSize: 56 },
  { id: 30, name: "bf16", blockSize: 1, typeSize: 2 },
  { id: 34, name: "tq1_0", blockSize: 256, typeSize: 54 },
  { id: 35, name: "tq2_0", blockSize: 256, typeSize: 66 },
  { id: 39, name: "mxfp4", blockSize: 32, typeSize: 17 },
  { id: 40, name: "nvfp4", blockSize: 64, typeSize: 36 },
  { id: 41, name: "q1_0", blockSize: 128, typeSize: 18 },
  { id: 42, name: "q2_0", blockSize: 64, typeSize: 18 },
];

export const GGML_TYPE_TRAITS: ReadonlyMap<number, GgmlTypeTrait> = new Map(
  TRAITS.map((trait) => [trait.id, trait]),
);

const TRAITS_BY_NAME: ReadonlyMap<string, GgmlTypeTrait> = new Map(
  TRAITS.map((trait) => [trait.name.toLowerCase(), trait]),
);

export function ggmlTypeTrait(typeId: number): GgmlTypeTrait | null {
  return GGML_TYPE_TRAITS.get(typeId) ?? null;
}

export function ggmlTypeTraitByName(name: string): GgmlTypeTrait | null {
  return TRAITS_BY_NAME.get(name.trim().toLowerCase()) ?? null;
}

export function ggmlTypeName(typeId: number): string | null {
  return GGML_TYPE_TRAITS.get(typeId)?.name ?? null;
}

export function ggmlRowSizeBytes(
  typeId: number,
  elements: number,
): number | null {
  const trait = GGML_TYPE_TRAITS.get(typeId);
  if (!trait || elements < 0) {
    return null;
  }
  return Math.ceil(elements / trait.blockSize) * trait.typeSize;
}

export function ggmlTensorBytes(typeId: number, dims: number[]): number | null {
  if (dims.length === 0) {
    return 0;
  }
  const elements = dims.reduce((product, dim) => product * dim, 1);
  return ggmlRowSizeBytes(typeId, elements);
}

export const GgufTensorInfoSchema = z.object({
  name: z.string(),
  typeId: z.number().int().nonnegative(),
  type: z.string(),
  dims: z.array(z.number().int().nonnegative()),
  elements: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});

export const GgufTensorTableSchema = z.object({
  path: z.string(),
  tensorCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  unknownTypeIds: z.array(z.number().int().nonnegative()),
  tensors: z.array(GgufTensorInfoSchema),
});

export type GgufTensorInfo = z.infer<typeof GgufTensorInfoSchema>;
export type GgufTensorTable = z.infer<typeof GgufTensorTableSchema>;
