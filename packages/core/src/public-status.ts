import { z } from "zod";

import { ApiProxyPublicModelStatusSchema } from "./proxy/api-proxy.js";

export const AuthStateSchema = z.object({
  enabled: z.boolean(),
  authenticated: z.boolean(),
});

export const AdminLoginSchema = z.object({
  password: z.string().min(1),
});

export const PublicProxyModelSchema = z.object({
  modelId: z.string(),
  status: ApiProxyPublicModelStatusSchema,
});

export const PublicStatusSchema = z.object({
  service: z.object({
    ok: z.boolean(),
    authRequired: z.boolean(),
    checkedAt: z.string(),
  }),
  models: z.object({
    total: z.number().int().nonnegative(),
    loaded: z.number().int().nonnegative(),
    activeRequests: z.number().int().nonnegative(),
    queuedRequests: z.number().int().nonnegative(),
    items: z.array(PublicProxyModelSchema),
  }),
});

export type AuthState = z.infer<typeof AuthStateSchema>;
export type AdminLogin = z.infer<typeof AdminLoginSchema>;
export type PublicProxyModel = z.infer<typeof PublicProxyModelSchema>;
export type PublicStatus = z.infer<typeof PublicStatusSchema>;
