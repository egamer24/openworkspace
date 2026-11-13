import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { z } from "zod";

import { isValidExternalEmailAddress } from "../../shared/email-address";
import { normalizeEmail } from "../lib/ids";
import { isValidXmlCharacters } from "../saml/xml-text";

const XML_CHARACTERS_ERROR =
  "Value contains characters that are not allowed in XML";

export const userNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .refine(isValidXmlCharacters, XML_CHARACTERS_ERROR);

export const emailSchema = z
  .string()
  .refine(isValidExternalEmailAddress, "Enter a valid email address")
  .max(254)
  .transform(normalizeEmail);

export const bootstrapInputSchema = z.object({
  name: userNameSchema,
  email: emailSchema,
});

/** WebAuthn's binary fields, as browsers serialize them in `toJSON()`. */
const base64UrlSchema = z.string().regex(/^[\w-]*$/u, "Not base64url");

/** The extension outputs WebAuthn defines; the server reads none of them. */
const clientExtensionResultsSchema = z.object({
  appid: z.boolean().optional(),
  credProps: z.object({ rk: z.boolean().optional() }).optional(),
  hmacCreateSecret: z.boolean().optional(),
  prf: z.object({ enabled: z.boolean().optional() }).optional(),
});

const publicKeyCredentialFields = {
  id: base64UrlSchema.min(1),
  rawId: base64UrlSchema.min(1),
  authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
  clientExtensionResults: clientExtensionResultsSchema,
  type: z.literal("public-key"),
};

export const registrationResponseSchema = z.object({
  ...publicKeyCredentialFields,
  response: z.object({
    clientDataJSON: base64UrlSchema,
    attestationObject: base64UrlSchema,
    authenticatorData: base64UrlSchema.optional(),
    transports: z.array(z.string()).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: base64UrlSchema.optional(),
  }),
}) satisfies z.ZodType<RegistrationResponseJSON>;

export const authenticationResponseSchema = z.object({
  ...publicKeyCredentialFields,
  response: z.object({
    clientDataJSON: base64UrlSchema,
    authenticatorData: base64UrlSchema,
    signature: base64UrlSchema,
    userHandle: base64UrlSchema.optional(),
  }),
}) satisfies z.ZodType<AuthenticationResponseJSON>;

const challengeIdSchema = z.string().trim().min(1).max(128);

export const registrationVerificationSchema = z.object({
  challengeId: challengeIdSchema,
  response: registrationResponseSchema,
});

export const authenticationVerificationSchema = z.object({
  challengeId: challengeIdSchema,
  response: authenticationResponseSchema,
});

export const mockBootstrapSchema = bootstrapInputSchema;

const identityRequestSchema = z
  .object({
    oidcRequestId: z.string().min(1).optional(),
    samlRequestId: z.string().min(1).optional(),
  })
  .refine(
    (input) => !(input.oidcRequestId && input.samlRequestId),
    "Only one identity request may be resumed"
  );

export const loginOptionsSchema = identityRequestSchema;

export const mockLoginSchema = z
  .object({
    userId: z.string().min(1),
  })
  .and(identityRequestSchema);
