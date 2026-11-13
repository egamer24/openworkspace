import { createHash, randomBytes } from "node:crypto";

import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import type { OidcScope } from "../shared/oidc.ts";
import {
  declaredOidcClientSchema,
  declaredSamlAppSchema,
} from "../shared/sso-declarations.ts";
import type { DeclaredAccess } from "../shared/sso-declarations.ts";
import { oidcClientDefaults } from "../shared/sso-defaults.ts";
import { OIDC_ISSUER_PATHS } from "../worker/oidc/constants.ts";
import { SAML_PATHS } from "../worker/saml/constants.ts";

/*
 * Single sign-on apps declared in alchemy.run.ts. Each resource mints its
 * ids (and a client secret) once and keeps them in the stack's state; its
 * `declaration` is what the Worker writes to D1 (a secret: it carries the
 * SCIM token when provisioning is declared). Apps declared here, their
 * provisioning included, are read-only in the admin UI.
 */

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/**
 * SCIM 2.0 provisioning of an app, as on its Provisioning tab in the admin
 * UI: people with access are created, updated and deactivated in the app,
 * and the teams shared with it become groups. Leaving it out of the
 * declaration turns provisioning off.
 */
export type ProvisioningProps = {
  /** The app's SCIM base URL, without /Users or /Groups; https only. */
  baseUrl: string;
  /**
   * The app's SCIM bearer token. A secret, never a plain string: e.g.
   * `yield* Config.Redacted("GRAFANA_SCIM_TOKEN")`, read from the
   * environment or `.env` when you deploy.
   */
  token: Redacted.Redacted<string>;
  /** Defaults to true; false pauses provisioning and keeps what was sent. */
  enabled?: boolean;
};

function provisioningDeclaration(provisioning: ProvisioningProps | undefined) {
  return provisioning
    ? {
        baseUrl: provisioning.baseUrl,
        token: Redacted.value(provisioning.token),
        enabled: provisioning.enabled,
      }
    : null;
}

export type OidcClientProps = {
  name: string;
  /** Exact URLs the app sends people back to after sign-in. */
  redirectUris: string[];
  /**
   * Who may sign in: "everyone", { teams: ["devs"] }, or
   * { teams: { devs: "developer", everyone: "viewer" } } to send each team
   * to the app as that value instead of its handle.
   */
  access: DeclaredAccess;
  /** Defaults to openid, profile, email. Add "groups" to tell the app which of the access teams each person is in. */
  scopes?: OidcScope[];
  /** "public" for apps that cannot keep a secret (browser, mobile). */
  clientType?: "confidential" | "public";
  postLogoutRedirectUris?: string[];
  allowedOrigins?: string[];
  /** Told when someone loses access (OpenID Connect Back-Channel Logout). */
  backchannelLogoutUri?: string;
  /** Skip the consent screen. */
  trusted?: boolean;
  /** Defaults to true; turn off only for confidential apps that cannot send PKCE. */
  requirePkce?: boolean;
  /** Keep the app's accounts in step over SCIM. */
  provisioning?: ProvisioningProps;
};

export type OidcClient = Resource<
  "OpenWorkspace.OidcClient",
  OidcClientProps,
  {
    clientId: string;
    /** For confidential clients; give it to the app. */
    clientSecret: Redacted.Redacted<string> | undefined;
    /** What the Worker stores: the client secret's hash, and the SCIM token. */
    declaration: Redacted.Redacted<string>;
  }
>;

/** An OpenID Connect app that signs in with the workspace. */
export const OidcClient = Resource<OidcClient>("OpenWorkspace.OidcClient");

export type SamlAppProps = {
  name: string;
  /** The app's entity ID (audience). */
  entityId: string;
  /** Where the app receives sign-ins (ACS / reply URL). */
  acsUrl: string;
  /** Who may sign in, as for OidcClient. */
  access: DeclaredAccess;
  nameIdFormat?: "email" | "persistent";
  /**
   * Attribute names; email and name default to "email" and "name". Set
   * groups to send which of the access teams each person is in.
   */
  attributes?: {
    email?: string;
    name?: string;
    firstName?: string;
    lastName?: string;
    groups?: string;
  };
  signResponse?: boolean;
  allowIdpInitiated?: boolean;
  /** PEM; when set, sign-in requests must be signed with it. */
  spSigningCertificate?: string;
  /** Keep the app's accounts in step over SCIM. */
  provisioning?: ProvisioningProps;
};

export type SamlApp = Resource<
  "OpenWorkspace.SamlApp",
  SamlAppProps,
  {
    applicationId: string;
    /** What the Worker stores, the SCIM token included. */
    declaration: Redacted.Redacted<string>;
  }
>;

/** A SAML service provider that signs in with the workspace. */
export const SamlApp = Resource<SamlApp>("OpenWorkspace.SamlApp");

function oidcDeclaration(
  props: OidcClientProps,
  clientId: string,
  secret: string | undefined
) {
  return Redacted.make(
    JSON.stringify(
      declaredOidcClientSchema.parse({
        protocol: "oidc",
        id: clientId,
        name: props.name,
        clientType: props.clientType,
        secretHash: secret
          ? createHash("sha256").update(secret).digest("base64url")
          : null,
        redirectUris: props.redirectUris,
        postLogoutRedirectUris: props.postLogoutRedirectUris,
        allowedOrigins: props.allowedOrigins,
        scopes: props.scopes,
        backchannelLogoutUri: props.backchannelLogoutUri,
        trusted: props.trusted,
        requirePkce: props.requirePkce,
        access: props.access,
        provisioning: provisioningDeclaration(props.provisioning),
      })
    )
  );
}

function samlDeclaration(props: SamlAppProps, applicationId: string) {
  const attributes = props.attributes ?? {};

  return Redacted.make(
    JSON.stringify(
      declaredSamlAppSchema.parse({
        protocol: "saml",
        id: applicationId,
        name: props.name,
        entityId: props.entityId,
        acsUrl: props.acsUrl,
        nameIdFormat: props.nameIdFormat,
        emailAttributeName: attributes.email,
        nameAttributeName: attributes.name,
        firstNameAttributeName: attributes.firstName,
        lastNameAttributeName: attributes.lastName,
        groupsAttributeName: attributes.groups,
        signResponse: props.signResponse,
        allowIdpInitiated: props.allowIdpInitiated,
        requireSignedAuthnRequests: Boolean(props.spSigningCertificate),
        spSigningCertificate: props.spSigningCertificate,
        access: props.access,
        provisioning: provisioningDeclaration(props.provisioning),
      })
    )
  );
}

const oidcClientProvider = Provider.succeed(OidcClient, {
  reconcile: ({
    news,
    output,
  }: {
    news: OidcClientProps;
    output?: OidcClient["Attributes"];
  }) =>
    Effect.sync(() => {
      const clientId = output?.clientId ?? `cli_${hex(16)}`;

      const confidential =
        (news.clientType ?? oidcClientDefaults.clientType) === "confidential";

      // The secret is minted once per client.
      const secret = confidential
        ? (output?.clientSecret ??
          Redacted.make(`owsec_${randomBytes(32).toString("base64url")}`))
        : undefined;

      return {
        clientId,
        clientSecret: secret,
        declaration: oidcDeclaration(
          news,
          clientId,
          secret && Redacted.value(secret)
        ),
      };
    }),
  delete: () => Effect.void,
  read: ({ output }: { output?: OidcClient["Attributes"] }) =>
    Effect.succeed(output),
  list: () => Effect.succeed([]),
});

const samlAppProvider = Provider.succeed(SamlApp, {
  reconcile: ({
    news,
    output,
  }: {
    news: SamlAppProps;
    output?: SamlApp["Attributes"];
  }) =>
    Effect.sync(() => {
      const applicationId = output?.applicationId ?? `sapp_${hex(16)}`;

      return {
        applicationId,
        declaration: samlDeclaration(news, applicationId),
      };
    }),
  delete: () => Effect.void,
  read: ({ output }: { output?: SamlApp["Attributes"] }) =>
    Effect.succeed(output),
  list: () => Effect.succeed([]),
});

/** Providers for the app resources above. */
export const ssoProviders = () =>
  Layer.mergeAll(oidcClientProvider, samlAppProvider);

/** Where the workspace signs people in, for apps to be pointed at. */
export type WorkspaceEndpoints = {
  url: string;
  oidc: {
    issuer: string;
    discoveryUrl: string;
    authorizationUrl: string;
    tokenUrl: string;
    userinfoUrl: string;
    jwksUrl: string;
  };
  saml: {
    entityId: string;
    ssoUrl: string;
    metadataUrl: string;
    /** The signing certificate, PEM. */
    certificate: Output.Output<string>;
    /**
     * The same certificate as its base64 body alone, without the BEGIN/END
     * lines or line breaks, as Cloudflare Access and some others ask for it.
     */
    certificateBody: Output.Output<string>;
  };
};

export function workspaceEndpoints(
  origin: string,
  certificate: Output.Output<string>
): WorkspaceEndpoints {
  return {
    url: origin,
    oidc: {
      issuer: origin,
      discoveryUrl: `${origin}${OIDC_ISSUER_PATHS.discovery}`,
      authorizationUrl: `${origin}${OIDC_ISSUER_PATHS.authorization}`,
      tokenUrl: `${origin}${OIDC_ISSUER_PATHS.token}`,
      userinfoUrl: `${origin}${OIDC_ISSUER_PATHS.userinfo}`,
      jwksUrl: `${origin}${OIDC_ISSUER_PATHS.jwks}`,
    },
    saml: {
      entityId: `${origin}${SAML_PATHS.metadata}`,
      ssoUrl: `${origin}${SAML_PATHS.sso}`,
      metadataUrl: `${origin}${SAML_PATHS.metadata}`,
      certificate,
      certificateBody: Output.map(certificate, (pem: string) =>
        pem
          .replaceAll(/-----(BEGIN|END) CERTIFICATE-----/gu, "")
          .replaceAll(/\s+/gu, "")
      ),
    },
  };
}
