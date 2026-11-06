import { z } from "zod";
import {
  oidcAccessPolicies,
  oidcClientTypes,
  oidcScopes,
} from "../../shared/oidc";
import { emailSchema, userNameSchema } from "../auth/schemas";
import { isValidExternalEmailAddress } from "../../shared/mail";
import {
  isAllowedOidcRedirectUri,
  normalizeAllowedOidcOrigin,
} from "../oidc/validation";
import { samlNameIdFormats } from "../../shared/saml";
import { mailboxStates } from "../mailbox/folder-model";
import { isValidXmlCharacters } from "../saml/xml";

const XML_CHARACTERS_ERROR = "Value contains characters that are not allowed in XML";

const mailboxMemberSchema = z.object({
  userId: z.string().min(1),
  canSend: z.boolean(),
});

const mailboxMembersSchema = z
  .array(mailboxMemberSchema)
  .min(1, "Choose at least one user")
  .max(100)
  .refine(
    (members) =>
      new Set(members.map((member) => member.userId)).size === members.length,
    { message: "A user may only be assigned once" },
  );

export const domainNameSchema = z.string()
  .trim()
  .toLowerCase()
  .max(253)
  .refine(
    (domain) => !domain.includes("@")
      && isValidExternalEmailAddress(`mailbox@${domain}`),
    "Enter a valid domain",
  );

const cloudflareZoneIdSchema = z.string()
  .trim()
  .toLowerCase()
  .regex(/^[a-f0-9]{32}$/u, "Zone ID must contain 32 hexadecimal characters")
  .nullable();

export const createDomainSchema = z.object({
  name: domainNameSchema,
  cloudflareZoneId: cloudflareZoneIdSchema.default(null),
});

export const cloudflareDomainSchema = z.object({ name: domainNameSchema });

export const cloudflareConnectSchema = cloudflareDomainSchema.extend({
  replaceMx: z.boolean().default(false),
});

export const updateDomainSchema = z.object({
  cloudflareZoneId: cloudflareZoneIdSchema.optional(),
  isPrimary: z.literal(true).optional(),
}).refine(
  (input) => input.cloudflareZoneId !== undefined || input.isPrimary === true,
  "Provide at least one domain change",
);

export const createInvitationSchema = z.object({
  name: userNameSchema,
  email: emailSchema,
});

export const createMailboxSchema = z.object({
  address: emailSchema,
  displayName: z.string().trim().min(2).max(80),
  ownerUserId: z.string().min(1).nullable(),
  members: z.array(mailboxMemberSchema).max(100),
}).superRefine((input, context) => {
  if (input.ownerUserId && input.members.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["members"],
      message: "Personal mailbox access follows its owner",
    });
  }
  if (!input.ownerUserId) {
    const parsed = mailboxMembersSchema.safeParse(input.members);
    for (const issue of parsed.error?.issues ?? []) {
      context.addIssue({ ...issue, path: ["members", ...issue.path] });
    }
  }
});

export const updateMailboxSchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  members: mailboxMembersSchema,
});

export const globalAiProcessingSchema = z.object({
  enabled: z.boolean(),
});

export const updateUserSchema = z.object({
  name: userNameSchema.optional(),
  status: z.enum(["active", "disabled"]).optional(),
  role: z.enum(["admin", "member"]).optional(),
}).refine(
  (input) => input.name !== undefined
    || input.status !== undefined
    || input.role !== undefined,
  "Provide at least one user change",
);

const uniqueStrings = <T extends z.ZodType<string>>(schema: T, max = 20) =>
  z.array(schema).max(max).refine(
    (values) => new Set(values).size === values.length,
    "Values must be unique",
  );

const redirectUriSchema = z.url().max(2048).refine(
  isAllowedOidcRedirectUri,
  "Redirect URI must use HTTPS, except HTTP loopback addresses, and have no fragment",
);

const originSchema = z.url().max(2048).transform((value, context) => {
  const origin = normalizeAllowedOidcOrigin(value);
  if (!origin) {
    context.addIssue({
      code: "custom",
      message: "Origin must be HTTPS or an HTTP loopback origin without a path",
    });
    return z.NEVER;
  }
  return origin;
});

const oidcClientSchema = z.object({
  name: z.string().trim().min(2).max(80),
  clientType: z.enum(oidcClientTypes),
  accessPolicy: z.enum(oidcAccessPolicies),
  redirectUris: uniqueStrings(redirectUriSchema).min(1),
  postLogoutRedirectUris: uniqueStrings(redirectUriSchema),
  allowedOrigins: uniqueStrings(originSchema),
  allowedScopes: uniqueStrings(z.enum(oidcScopes), oidcScopes.length).refine(
    (scopes) => scopes.includes("openid"),
    "The openid scope is required",
  ),
  trusted: z.boolean(),
  enabled: z.boolean(),
  assignedUserIds: uniqueStrings(z.string().min(1), 100),
  exposedGroupIds: uniqueStrings(z.string().min(1), 100),
});

export const createOidcClientSchema = oidcClientSchema;
export const updateOidcClientSchema = oidcClientSchema;

const samlApplicationSchema = z.object({
  name: z.string().trim().min(2).max(80),
  entityId: z.url().max(2_048)
    .refine(isValidXmlCharacters, XML_CHARACTERS_ERROR),
  acsUrl: redirectUriSchema
    .refine(isValidXmlCharacters, XML_CHARACTERS_ERROR),
  nameIdFormat: z.enum(samlNameIdFormats),
  accessPolicy: z.enum(oidcAccessPolicies),
  emailAttributeName: z.string().trim().min(1).max(256)
    .refine(isValidXmlCharacters, XML_CHARACTERS_ERROR),
  nameAttributeName: z.string().trim().min(1).max(256)
    .refine(isValidXmlCharacters, XML_CHARACTERS_ERROR),
  groupsAttributeName: z.string().trim().min(1).max(256)
    .refine(isValidXmlCharacters, XML_CHARACTERS_ERROR)
    .nullable(),
  signResponse: z.boolean(),
  requireSignedAuthnRequests: z.boolean(),
  spSigningCertificate: z.string().trim().max(32_768).nullable(),
  allowIdpInitiated: z.boolean(),
  enabled: z.boolean(),
  assignedUserIds: uniqueStrings(z.string().min(1), 100),
  exposedGroupIds: uniqueStrings(z.string().min(1), 100),
}).refine(
  (input) => !input.requireSignedAuthnRequests || input.spSigningCertificate,
  "A service-provider certificate is required for signed AuthnRequest messages",
).refine(
  (input) => Boolean(input.groupsAttributeName) || input.exposedGroupIds.length === 0,
  {
    message: "A groups attribute is required when exposing groups",
    path: ["exposedGroupIds"],
  },
);

export const createSamlApplicationSchema = samlApplicationSchema;
export const updateSamlApplicationSchema = samlApplicationSchema;

export const groupInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  description: z.string().trim().max(240).nullable(),
  memberIds: uniqueStrings(z.string().min(1), 100),
});

export const mailImportQuerySchema = z.object({
  state: z.enum(mailboxStates).default("active"),
  direction: z.enum(["incoming", "outgoing", "auto"]).default("auto"),
  seen: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  folder: z.string().trim().min(1).max(80).optional(),
  receivedAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional(),
});

export const forwardingDestinationSchema = z.object({
  // Cloudflare limits destination addresses to 90 characters.
  email: emailSchema.refine((email) => email.length <= 90, "Address is too long"),
});

export const destinationVerifiedSchema = z.object({ verified: z.boolean() });

export const routingAddressSchema = z.object({
  address: emailSchema,
  mailboxId: z.string().min(1).nullable().default(null),
  destinationIds: uniqueStrings(z.string().min(1), 10).default([]),
  keepCopy: z.boolean().default(true),
});

export const unknownRecipientSchema = z.object({
  mailboxId: z.string().min(1).nullable(),
});
