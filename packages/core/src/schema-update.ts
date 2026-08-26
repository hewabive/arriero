import { z } from "zod";

type WithoutDefault<T extends z.core.SomeType> =
  T extends z.ZodDefault<infer Inner extends z.core.SomeType>
    ? WithoutDefault<Inner>
    : T;

type UpdateShape<Shape extends z.ZodRawShape> = {
  [K in keyof Shape]: z.ZodOptional<WithoutDefault<Shape[K]>>;
};

function withoutDefault(field: z.core.SomeType): z.core.SomeType {
  return field instanceof z.ZodDefault ? withoutDefault(field.unwrap()) : field;
}

export function updateSchemaFrom<Shape extends z.ZodRawShape>(
  record: z.ZodObject<Shape>,
): z.ZodObject<UpdateShape<Shape>> {
  const shape: Record<string, z.core.SomeType> = {};
  for (const [key, field] of Object.entries(record.shape)) {
    shape[key] = z.optional(withoutDefault(field));
  }
  return z.object(shape) as unknown as z.ZodObject<UpdateShape<Shape>>;
}
