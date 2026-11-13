import { z } from "zod";

import { isOidcScopeName, oidcClientTypes } from "./oidc.ts";
import { samlNameIdFormats } from "./saml.ts";
import { oidcClientDefaults, samlAppDefaults } from "./sso-defaults.ts";

/*
 * Single sign-on apps declared in alchemy.run.ts. Alchemy turns each into a
 * declaration (a confidential client carries its secret's SHA-256; declared
 * provisioning, its SCIM token), binds the list as the SSO_APPS secret, and
 * the Worker keeps D1 in step.
 */

/** A team handle, such as engineering. */
const handle = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

/**
 * Who may sign in: everyone active in the workspace, or the members of these
 * teams. With the groups scope (or a groups attribute) the app also learns
 * which of these teams each person is in: by handle, or by the value given
 * for the team ({ devs: "developer", everyone: "view_only" }).
 */
export const declaredAccessSchema = z.union([
  z.literal("everyone"),
  z.object({
    teams: z.union([
      z.array(handle).min(1).max(100),
      z
        .record(handle, z.string().trim().min(1).max(256).nullable())
        .refine(
          (teams) => Object.keys(teams).length > 0,
          "List at least one team"
        ),
    ]),
  }),
]);

const httpsUrl = z
  .string()
  .url()
  .max(2048)
  .refine(
    (value) => new URL(value).protocol === "https:",
    "Use an https:// URL"
  );

/** Called by the Worker, never a browser: public HTTPS, no credentials or fragment. */
const scimBaseUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);

    return (
      url.protocol === "https:" && !url.username && !url.password && !url.hash
    );
  }, "Use an HTTPS URL without credentials or a fragment");

/** SCIM provisioning of the app, as its Provisioning tab stores it; null turns it off. */
const declaredProvisioningSchema = z
  .object({
    baseUrl: scimBaseUrl,
    token: z.string().trim().min(1).max(4096),
    enabled: z.boolean().default(true),
  })
  .nullable()
  .default(null);

export const declaredOidcClientSchema = z.object({
  protocol: z.literal("oidc"),
  id: z.string().regex(/^cli_[a-f0-9]{32}$/u),
  name: z.string().trim().min(2).max(80),
  clientType: z.enum(oidcClientTypes).default(oidcClientDefaults.clientType),
  /** base64url SHA-256 of the client secret, for confidential clients. */
  secretHash: z.string().min(43).max(43).nullable(),
  redirectUris: z.array(z.string().url().max(2048)).min(1).max(20),
  postLogoutRedirectUris: z
    .array(z.string().url().max(2048))
    .max(20)
    .default([]),
  allowedOrigins: z.array(z.string().url().max(2048)).max(20).default([]),
  scopes: z
    .array(z.string().refine(isOidcScopeName, "Unknown scope"))
    .min(1)
    .refine((scopes) => scopes.includes("openid"), "openid is required")
    .default(() => [...oidcClientDefaults.scopes]),
  backchannelLogoutUri: httpsUrl.nullable().default(null),
  trusted: z.boolean().default(oidcClientDefaults.trusted),
  requirePkce: z.boolean().default(oidcClientDefaults.requirePkce),
  access: declaredAccessSchema,
  provisioning: declaredProvisioningSchema,
});

export const declaredSamlAppSchema = z.object({
  protocol: z.literal("saml"),
  id: z.string().regex(/^sapp_[a-f0-9]{32}$/u),
  name: z.string().trim().min(2).max(80),
  entityId: z.string().min(1).max(2048),
  acsUrl: httpsUrl,
  nameIdFormat: z.enum(samlNameIdFormats).default(samlAppDefaults.nameIdFormat),
  emailAttributeName: z
    .string()
    .min(1)
    .max(256)
    .default(samlAppDefaults.emailAttributeName),
  nameAttributeName: z
    .string()
    .min(1)
    .max(256)
    .default(samlAppDefaults.nameAttributeName),
  firstNameAttributeName: z.string().min(1).max(256).nullable().default(null),
  lastNameAttributeName: z.string().min(1).max(256).nullable().default(null),
  groupsAttributeName: z.string().min(1).max(256).nullable().default(null),
  signResponse: z.boolean().default(samlAppDefaults.signResponse),
  allowIdpInitiated: z.boolean().default(samlAppDefaults.allowIdpInitiated),
  requireSignedAuthnRequests: z.boolean().default(false),
  spSigningCertificate: z.string().max(32_768).nullable().default(null),
  access: declaredAccessSchema,
  provisioning: declaredProvisioningSchema,
});

export const declaredSsoAppSchema = z.discriminatedUnion("protocol", [
  declaredOidcClientSchema,
  declaredSamlAppSchema,
]);

export const declaredSsoAppsSchema = z.array(declaredSsoAppSchema).max(100);

export type DeclaredOidcClient = z.infer<typeof declaredOidcClientSchema>;

export type DeclaredSamlApp = z.infer<typeof declaredSamlAppSchema>;

export type DeclaredSsoApp = z.infer<typeof declaredSsoAppSchema>;

export type DeclaredAccess = z.infer<typeof declaredAccessSchema>;

export type DeclaredProvisioning = z.infer<typeof declaredProvisioningSchema>;
