# Single sign-on

People can sign in to your other apps with their workspace account. The
workspace works as an OpenID Connect (OIDC) and SAML 2.0 identity provider, and
can create and remove accounts in those apps over SCIM. You choose which teams
can use each app.

## Add an app

1. Open **Administration → Single sign-on apps → Add an app**.
2. Choose **OpenID Connect** if the app asks for a client ID, an issuer, or a
   discovery URL. Otherwise choose **SAML**.
3. Enter the app's details and choose who can sign in.
4. Copy the values under **Give these to the app** into the app's settings.
   Each value also lists the other names apps use for it.

### Access by team

Under **Access**, pick the teams whose members can use the app, or Everyone. To
let a single person in, add them to one of those teams.

You can give each team a value the app understands, such as a role name. For
example, the `devs` team could send `developer`, and Everyone could send
`view_only`. The app then receives the values of every team the person is in,
through the `groups` scope (OIDC) or a groups attribute (SAML). Teams without a
value aren't sent.

When someone leaves a team, or a team loses access, the app's tokens for that
person are revoked.

## OpenID Connect

Apps find everything they need at the discovery URL:

```text
https://mail.example.com/.well-known/openid-configuration
```

| What the app needs    | Value                                                                     |
| --------------------- | ------------------------------------------------------------------------- |
| Flow                  | Authorization Code with PKCE                                              |
| Client authentication | `client_secret_basic` or `client_secret_post`, or none for public clients |
| Scopes                | `openid profile email groups offline_access`                              |
| Claims                | `name` and `picture` (with `profile`), `email`, `groups`                  |

- PKCE is required. If an app with a client secret can't send it, turn off
  **Require PKCE** for that app.
- To have the app notified when a person is disabled or loses access, set the
  **Sign-out notification URL** under the app's Advanced settings
  ([Back-Channel Logout](https://openid.net/specs/openid-connect-backchannel-1_0.html)).
- Only administrators can turn on **Skip the consent screen**, or let an app
  use workspace scopes such as `mail.read` ([scopes](mcp-and-jmap.md#scopes)).

## SAML

The identity provider's metadata is at:

```text
https://mail.example.com/saml/metadata
```

To add a SAML app, paste its metadata URL, upload its metadata XML, or enter
its entity ID and ACS URL by hand. **Give these to the app** then shows the
metadata URL, SSO URL, entity ID, and signing certificate (as text, `.pem` or
`.cer`).

- People can start from the app or from the workspace. Each app has a sign-in
  link, and **Test sign-in** uses it.
- By default the app receives `email` and `name`, plus `groups` if you gave
  teams values. Advanced settings switch to Microsoft-style claim names and add
  first and last names.
- Encrypted assertions and Single Logout aren't supported. Use SCIM to remove
  people from the app.

## SCIM provisioning

With SCIM, the workspace keeps the app's accounts in step:

- People with access are created in the app before they first sign in, and
  updated when their name or address changes.
- People who lose access or are disabled are deactivated.
- Teams shared with the app become groups there.
- Existing accounts and groups with the same name are linked, not duplicated.

To set it up, open the app under **Administration → Single sign-on apps**, go
to the **Provisioning** tab, and enter the app's SCIM base URL and bearer
token. Changes reach the app within a minute. The last error, if any, is shown
on the same tab.

## Declare apps in code

Instead of using the admin UI, you can declare apps in `alchemy.run.ts` with
`OidcClient` and `SamlApp`. Each deploy keeps them in step, and the admin UI
shows them read-only.

`access` is required: `"everyone"`, or the teams by handle, such as
`{ teams: ["engineering"] }`. To send values to the app, map teams to values:
`{ teams: { devs: "developer", everyone: "view_only" } }`.

```ts
import * as Config from "effect/Config";

Effect.gen(function* () {
  const grafana = yield* OidcClient("Grafana", {
    name: "Grafana",
    redirectUris: ["https://grafana.acme.com/login/generic_oauth"],
    scopes: ["openid", "profile", "email", "groups"],
    access: { teams: { engineering: "Editor", sre: "Admin" } },
    // Optional SCIM. The token is read from .env when you deploy.
    provisioning: {
      baseUrl: "https://grafana.acme.com/api/scim/v2",
      token: yield* Config.Redacted("GRAFANA_SCIM_TOKEN"),
    },
  });
  const workspace = yield* OpenWorkspace({
    hostname: "mail.acme.com",
    mailDomains: ["acme.com"],
    modules: [Email()],
    apps: [grafana],
  });
  return { issuer: workspace.oidc.issuer };
});
```

The SCIM token must be a secret (`Config.Redacted`), so it never ends up in
the file. Set `provisioning.enabled: false` to pause provisioning; remove
`provisioning` to turn it off.

`OidcClient` returns `clientId` and `clientSecret`, and `SamlApp` returns
`applicationId`. `OpenWorkspace` returns the values other resources need:

| Output                                                                       | Value                                              |
| ---------------------------------------------------------------------------- | -------------------------------------------------- |
| `url`                                                                        | `https://<hostname>`                               |
| `oidc.issuer`, `oidc.discoveryUrl`                                           | The issuer and its discovery URL                   |
| `oidc.authorizationUrl`, `oidc.tokenUrl`, `oidc.userinfoUrl`, `oidc.jwksUrl` | The OIDC endpoints                                 |
| `saml.entityId`, `saml.ssoUrl`, `saml.metadataUrl`                           | The SAML entity ID, SSO URL and metadata URL       |
| `saml.certificate`, `saml.certificateBody`                                   | The signing certificate as PEM, and as bare base64 |

### Connecting Cloudflare Access

To let people sign in to Cloudflare Zero Trust with the workspace, declare an
app and add it as a login method with `Cloudflare.Access.IdentityProvider`. The
callback is `/cdn-cgi/access/callback` on your team domain. Team values reach
Access as groups you can use in its policies.

```ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import { required } from "@open-workspace/core/shared";
import * as Output from "alchemy/Output";
import * as Redacted from "effect/Redacted";

const callback = "https://acme.cloudflareaccess.com/cdn-cgi/access/callback";

Effect.gen(function* () {
  const access = yield* OidcClient("CloudflareAccess", {
    name: "Cloudflare Access",
    redirectUris: [callback],
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
    name: "Acme Workspace", // shown on the Access sign-in page
    type: "oidc",
    config: {
      clientId: access.clientId,
      // Access takes the secret as a plain string.
      clientSecret: access.clientSecret.pipe(
        Output.map((secret) =>
          Redacted.value(required(secret, "a confidential client has a secret"))
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
});
```

To use SAML instead, declare a `SamlApp` with the callback as both its entity
ID and ACS URL, and pass the certificate's bare body:

```ts
const access =
  yield *
  SamlApp("CloudflareAccess", {
    name: "Cloudflare Access",
    entityId: callback,
    acsUrl: callback,
    access: { teams: { engineering: "engineering" } },
    attributes: { groups: "groups" },
    allowIdpInitiated: false,
  });
// … OpenWorkspace({ …, apps: [access] }) as above, then:
yield *
  Cloudflare.Access.IdentityProvider("WorkspaceLogin", {
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
```
