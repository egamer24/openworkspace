import type {
  OidcClientRegistration,
  OidcClientType,
  OidcScope,
} from "./oidc.ts";
import type { SamlNameIdFormat } from "./saml.ts";

/*
 * What a single sign-on app is when nothing says otherwise: the defaults of
 * the declarations in alchemy.run.ts (shared/sso-declarations.ts) and of a
 * new app in the admin UI.
 */

type OidcClientDefaults = {
  clientType: OidcClientType;
  scopes: OidcScope[];
  trusted: boolean;
  requirePkce: boolean;
};

export const oidcClientDefaults: OidcClientDefaults = {
  clientType: "confidential",
  scopes: ["openid", "profile", "email"],
  trusted: false,
  requirePkce: true,
};

type SamlAppDefaults = {
  nameIdFormat: SamlNameIdFormat;
  emailAttributeName: string;
  nameAttributeName: string;
  signResponse: boolean;
  allowIdpInitiated: boolean;
};

export const samlAppDefaults: SamlAppDefaults = {
  nameIdFormat: "email",
  emailAttributeName: "email",
  nameAttributeName: "name",
  signResponse: true,
  allowIdpInitiated: true,
};

/**
 * Whether a client must use PKCE: always, except an administrator-added
 * (or declared) app that keeps a secret and has it turned off because the
 * app cannot send it. Public clients always use it.
 */
export function pkceRequired(client: {
  clientType: OidcClientType;
  requirePkce: boolean;
  registration?: OidcClientRegistration;
}) {
  return (
    (client.registration ?? "admin") !== "admin" ||
    client.clientType !== "confidential" ||
    client.requirePkce
  );
}
