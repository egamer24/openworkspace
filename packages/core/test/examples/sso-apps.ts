import * as Cloudflare from "@alchemy.run/cloudflare";
import {
  OidcClient,
  OpenWorkspace,
  providers,
  SamlApp,
} from "@open-workspace/core/alchemy";
import { required } from "@open-workspace/core/shared";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/*
 * The README's examples of apps declared in alchemy.run.ts, typechecked
 * (`bun run typecheck`) but never deployed: an app with SCIM provisioning,
 * and Cloudflare Zero Trust signing people in with the workspace over OIDC
 * and over SAML.
 */

export const provisioned = Alchemy.Stack(
  "Workspace",
  { providers: providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const grafana = yield* OidcClient("Grafana", {
      name: "Grafana",
      redirectUris: ["https://grafana.acme.com/login/generic_oauth"],
      scopes: ["openid", "profile", "email", "groups"],
      access: { teams: { engineering: "Editor", sre: "Admin" } },
      provisioning: {
        baseUrl: "https://grafana.acme.com/api/scim/v2",
        token: yield* Config.Redacted("GRAFANA_SCIM_TOKEN"),
      },
    });

    const workspace = yield* OpenWorkspace({
      hostname: "mail.acme.com",
      mailDomains: ["acme.com"],
      apps: [grafana],
    });

    return { issuer: workspace.oidc.issuer };
  })
);

const team = "acme";
const callback = `https://${team}.cloudflareaccess.com/cdn-cgi/access/callback`;

export const oidc = Alchemy.Stack(
  "Workspace",
  { providers: providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const access = yield* OidcClient("CloudflareAccess", {
      name: "Cloudflare Access",
      redirectUris: [callback],
      // Teams given a value reach Access as groups, for its policies.
      scopes: ["openid", "profile", "email", "groups"],
      access: { teams: { engineering: "engineering", sre: "sre" } },
      trusted: true,
    });

    const workspace = yield* OpenWorkspace({
      hostname: "mail.acme.com",
      mailDomains: ["acme.com"],
      apps: [access],
    });

    yield* Cloudflare.Access.IdentityProvider("WorkspaceLogin", {
      name: "Acme Workspace",
      type: "oidc",
      config: {
        clientId: access.clientId,
        // Access takes the secret as a string; a new one is still noticed and sent.
        clientSecret: access.clientSecret.pipe(
          Output.map((secret) =>
            Redacted.value(
              required(secret, "a confidential client has a secret")
            )
          )
        ),
        authUrl: workspace.oidc.authorizationUrl,
        tokenUrl: workspace.oidc.tokenUrl,
        certsUrl: workspace.oidc.jwksUrl,
        scopes: ["openid", "email", "profile", "groups"],
        claims: ["name", "groups"],
        pkceEnabled: true,
      },
    });
  })
);

export const saml = Alchemy.Stack(
  "Workspace",
  { providers: providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const access = yield* SamlApp("CloudflareAccess", {
      name: "Cloudflare Access",
      entityId: callback,
      acsUrl: callback,
      access: { teams: { engineering: "engineering" } },
      attributes: { groups: "groups" },
      allowIdpInitiated: false,
    });

    const workspace = yield* OpenWorkspace({
      hostname: "mail.acme.com",
      mailDomains: ["acme.com"],
      apps: [access],
    });

    yield* Cloudflare.Access.IdentityProvider("WorkspaceLogin", {
      name: "Acme Workspace",
      type: "saml",
      config: {
        issuerUrl: workspace.saml.entityId,
        ssoTargetUrl: workspace.saml.ssoUrl,
        idpPublicCerts: [workspace.saml.certificateBody],
        emailAttributeName: "email",
        attributes: ["name", "groups"],
      },
    });
  })
);
