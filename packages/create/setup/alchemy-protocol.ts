import { z } from "zod";

/** How create authenticates to the Cloudflare API: the credentials a deploy would use. */
export const cloudflareAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("token"), token: z.string().min(1) }),
  z.object({
    type: z.literal("apiKey"),
    key: z.string().min(1),
    email: z.string().min(1),
  }),
]);

export type CloudflareAuth = z.infer<typeof cloudflareAuthSchema>;

export const credentialsReplySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    /** "environment" when CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are set: they win over every profile. */
    source: z.enum(["profile", "environment"]),
    profile: z.string(),
    /** "oauth", "stored", or "environment". */
    method: z.string(),
    accountId: z.string(),
    auth: cloudflareAuthSchema,
  }),
  z.object({ status: z.literal("missing"), message: z.string() }),
  z.object({ status: z.literal("invalid"), message: z.string() }),
]);

export type CredentialsReply = z.infer<typeof credentialsReplySchema>;

export const profilesReplySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    active: z.string(),
    profiles: z.array(
      z.object({
        name: z.string(),
        cloudflare: z
          .object({ method: z.string(), accountId: z.string().optional() })
          .optional(),
      })
    ),
  }),
  z.object({ status: z.literal("invalid"), message: z.string() }),
]);

export type ProfilesReply = z.infer<typeof profilesReplySchema>;

export const setAccountReplySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    profile: z.string(),
    accountId: z.string(),
  }),
  z.object({ status: z.literal("missing"), message: z.string() }),
  z.object({ status: z.literal("invalid"), message: z.string() }),
]);

export type SetAccountReply = z.infer<typeof setAccountReplySchema>;

/** Everything the helper may print. */
export type HelperReply = CredentialsReply | ProfilesReply | SetAccountReply;
