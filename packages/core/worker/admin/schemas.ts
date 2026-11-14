import { z } from "zod";

import { oidcClientTypes } from "../../shared/oidc";
import { samlNameIdFormats } from "../../shared/saml";
import {
  listPostingPolicies,
  MAX_FORWARD_DESTINATIONS,
  mailboxDeliveries,
} from "../../shared/workspace";
import { emailSchema, userNameSchema } from "../auth/schemas";
import { workspacePermissions } from "../modules";
import { isKnownScope } from "../oidc/scopes";
import {
  isAllowedOidcRedirectUri,
  normalizeAllowedOidcOrigin,
} from "../oidc/validation";
import { isValidXmlCharacters } from "../saml/xml-text";

const XML_CHARACTERS_ERROR =
  "Value contains characters that are not allowed in XML";

/**
 * SAML names a service provider by a URI: usually a URL, sometimes a URN such
 * as urn:amazon:webservices. Older Google Workspace setups use a bare name
 * like google.com or google.com/a/example.com, so that form is accepted too.
 */
export function isSamlEntityId(value: string) {
  if (
    value.length > 1024 ||
    /\s/u.test(value) ||
    !isValidXmlCharacters(value)
  ) {
    return false;
  }

  if (/^https?:/iu.test(value)) {
    try {
      const url = new URL(value);

      return Boolean(url.hostname) && !url.username && !url.password;
    } catch {
      return false;
    }
  }

  return (
    /^[a-z][a-z0-9+.-]*:[^\s]+$/iu.test(value) ||
    /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?$/iu.test(value)
  );
}

export const createInvitationSchema = z.object({
  name: userNameSchema,
  email: emailSchema,
});

/** A forward's outside addresses: distinct, lowercase, at most five. */
const forwardToSchema = z
  .array(emailSchema)
  .min(1)
  .max(MAX_FORWARD_DESTINATIONS)
  .transform((values) => [
    ...new Set(values.map((value) => value.toLowerCase())),
  ]);

/**
 * How an address delivers. An alias names the mailbox it delivers into, a
 * forward its outside addresses; only an inbox can be its domain's catch-all.
 * Checked against the stored rows in admin/mailbox-routes.ts.
 */
const deliveryFields = {
  aliasOf: z.string().min(1).nullable().optional(),
  forwardTo: forwardToSchema.nullable().optional(),
  catchAll: z.boolean().optional(),
};

/** A mailbox belongs to one person, or is shared by the members of one team. */
export const createMailboxSchema = z
  .object({
    address: emailSchema,
    displayName: z.string().trim().min(2).max(80),
    ownerUserId: z.string().min(1).nullable(),
    teamId: z.string().min(1).nullable(),
    delivery: z.enum(mailboxDeliveries).default("inbox"),
    listPosting: z.enum(listPostingPolicies).default("workspace"),
    ...deliveryFields,
  })
  .refine((input) => Boolean(input.ownerUserId) !== Boolean(input.teamId), {
    message: "Choose either an owner or a team",
    path: ["teamId"],
  })
  .refine((input) => input.delivery !== "list" || Boolean(input.teamId), {
    message: "Only a team address can be a mailing list",
    path: ["delivery"],
  });

export const updateMailboxSchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  /** Team mailboxes only: the team. */
  teamId: z.string().min(1).optional(),
  delivery: z.enum(mailboxDeliveries).optional(),
  listPosting: z.enum(listPostingPolicies).optional(),
  ...deliveryFields,
});

export const updateUserSchema = z
  .object({
    name: userNameSchema.optional(),
    status: z.enum(["active", "disabled"]).optional(),
    role: z.enum(["admin", "member"]).optional(),
    /** What a member may manage; ignored for administrators, who manage everything. */
    permissions: z
      .array(
        z
          .string()
          .refine(
            (id) =>
              workspacePermissions().some((permission) => permission.id === id),
            "Unknown permission"
          )
      )
      .max(100)
      .transform((values) => [...new Set(values)])
      .optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.status !== undefined ||
      input.role !== undefined ||
      input.permissions !== undefined,
    "Provide at least one user change"
  );

const uniqueStrings = <T extends z.ZodType<string>>(schema: T, max = 20) =>
  z
    .array(schema)
    .max(max)
    .refine(
      (values) => new Set(values).size === values.length,
      "Values must be unique"
    );

/**
 * Teams whose members may sign in (the Everyone team admits everyone), each
 * with what the app receives for it in groups instead of its handle.
 */
export const accessTeamsSchema = z
  .array(
    z.object({
      teamId: z.string().min(1),
      sentAs: z
        .string()
        .trim()
        .min(1)
        .max(256)
        .refine(isValidXmlCharacters, "Use printable characters")
        .nullable()
        .default(null),
    })
  )
  .max(100)
  .refine(
    (teams) => new Set(teams.map((team) => team.teamId)).size === teams.length,
    "A team may only be listed once"
  );

const redirectUriSchema = z
  .url()
  .max(2048)
  .refine(
    isAllowedOidcRedirectUri,
    "Redirect URI must use HTTPS, except HTTP loopback addresses, and have no fragment"
  );

/** Called by this Worker, never by a browser, so only public HTTPS is useful. */
export const serverCallbackUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);

    return (
      url.protocol === "https:" && !url.username && !url.password && !url.hash
    );
  }, "Use an HTTPS URL without credentials or a fragment");

const originSchema = z
  .url()
  .max(2048)
  .transform((value, context) => {
    const origin = normalizeAllowedOidcOrigin(value);

    if (!origin) {
      context.addIssue({
        code: "custom",
        message:
          "Origin must be HTTPS or an HTTP loopback origin without a path",
      });

      return z.NEVER;
    }

    return origin;
  });

const oidcClientSchema = z.object({
  name: z.string().trim().min(2).max(80),
  clientType: z.enum(oidcClientTypes),
  accessTeams: accessTeamsSchema,
  redirectUris: uniqueStrings(redirectUriSchema).min(1),
  postLogoutRedirectUris: uniqueStrings(redirectUriSchema),
  allowedOrigins: uniqueStrings(originSchema),
  /** Identity scopes, and workspace scopes (mail, people, administration) for administrators to allow. */
  allowedScopes: uniqueStrings(
    z.string().refine(isKnownScope, "Unknown scope"),
    64
  ).refine(
    (scopes) => scopes.includes("openid"),
    "The openid scope is required"
  ),
  trusted: z.boolean(),
  enabled: z.boolean(),
  backchannelLogoutUri: serverCallbackUrlSchema.nullable().default(null),
  /** Only confidential clients may skip PKCE; public clients always use it. */
  requirePkce: z.boolean().default(true),
});

export const createOidcClientSchema = oidcClientSchema;
export const updateOidcClientSchema = oidcClientSchema;

const optionalAttributeName = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(isValidXmlCharacters, XML_CHARACTERS_ERROR)
  .nullable()
  .default(null);

const samlApplicationSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    entityId: z
      .string()
      .trim()
      .min(1)
      .refine(
        isSamlEntityId,
        "Entity ID must be a URL, a URN, or a name like google.com, without spaces"
      ),
    acsUrl: redirectUriSchema.refine(
      isValidXmlCharacters,
      XML_CHARACTERS_ERROR
    ),
    nameIdFormat: z.enum(samlNameIdFormats),
    accessTeams: accessTeamsSchema,
    emailAttributeName: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine(isValidXmlCharacters, XML_CHARACTERS_ERROR),
    nameAttributeName: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine(isValidXmlCharacters, XML_CHARACTERS_ERROR),
    groupsAttributeName: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine(isValidXmlCharacters, XML_CHARACTERS_ERROR)
      .nullable(),
    firstNameAttributeName: optionalAttributeName,
    lastNameAttributeName: optionalAttributeName,
    signResponse: z.boolean(),
    requireSignedAuthnRequests: z.boolean(),
    spSigningCertificate: z.string().trim().max(32_768).nullable(),
    allowIdpInitiated: z.boolean(),
    enabled: z.boolean(),
  })
  .refine(
    (input) => !input.requireSignedAuthnRequests || input.spSigningCertificate,
    "A service-provider certificate is required for signed AuthnRequest messages"
  );

export const createSamlApplicationSchema = samlApplicationSchema;
export const updateSamlApplicationSchema = samlApplicationSchema;

/** A handle released to SSO applications, such as engineering. */
const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

/** The complete list of teams a person is on, besides Everyone. */
export const personTeamsSchema = z.object({
  teamIds: uniqueStrings(z.string().min(1), 500),
});

export const teamInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: slugSchema,
  description: z.string().trim().max(240).nullable(),
  /** Everyone active in the workspace belongs; members are then ignored. */
  everyone: z.boolean().default(false),
  members: z
    .array(
      z.object({
        userId: z.string().min(1),
        canSend: z.boolean().default(true),
      })
    )
    .max(500)
    .refine(
      (members) =>
        new Set(members.map((member) => member.userId)).size === members.length,
      "A person may only be added once"
    ),
});
