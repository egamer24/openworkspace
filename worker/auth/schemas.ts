import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { z } from "zod";
import { accountApiTokenScopes } from "../../shared/auth";
import { isValidExternalEmailAddress } from "../../shared/mail";
import { normalizeEmail } from "../lib/ids";
import { isValidXmlCharacters } from "../saml/xml";

const XML_CHARACTERS_ERROR = "Value contains characters that are not allowed in XML";

export const userNameSchema = z.string()
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

function isCredentialResponse(value: unknown): value is { id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string"
  );
}

export const registrationResponseSchema = z.custom<RegistrationResponseJSON>(
  isCredentialResponse,
  "Invalid passkey registration response",
);

export const authenticationResponseSchema =
  z.custom<AuthenticationResponseJSON>(
    isCredentialResponse,
    "Invalid passkey authentication response",
  );

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
const identityRequestSchema = z.object({
  oidcRequestId: z.string().min(1).optional(),
  samlRequestId: z.string().min(1).optional(),
}).refine(
  (input) => !(input.oidcRequestId && input.samlRequestId),
  "Only one identity request may be resumed",
);

export const loginOptionsSchema = identityRequestSchema;
export const mockLoginSchema = z.object({
  userId: z.string().min(1),
}).and(identityRequestSchema);

export const createAccountApiTokenSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scope: z.enum(accountApiTokenScopes).default("full"),
});
