import { isOidcScopeName } from "../../shared/oidc";
import type { IdentityScope, OidcScope } from "../../shared/oidc";
import type { SamlNameIdFormat } from "../../shared/saml";
import {
  oidcClientDefaults,
  pkceRequired,
  samlAppDefaults,
} from "../../shared/sso-defaults";
import type {
  AdminOidcClient,
  AdminSamlApplication,
  AdminSamlApplicationDetails,
} from "./types";

/** The OIDC app as the admin edits it; redirect URLs stay text until saved. */
/** A team that may sign in, and what the app receives for it ("" for its handle). */
export type AccessTeamInput = { teamId: string; sentAs: string };

export type OidcAppInput = {
  name: string;
  clientType: "public" | "confidential";
  /** Teams whose members may sign in; the Everyone team admits everyone. */
  accessTeams: AccessTeamInput[];
  redirectUri: string;
  extraRedirectUris: string;
  postLogoutRedirectUris: string;
  allowedOrigins: string;
  allowedScopes: OidcScope[];
  trusted: boolean;
  enabled: boolean;
  requirePkce: boolean;
  backchannelLogoutUri: string;
};

export type SamlAppInput = {
  name: string;
  entityId: string;
  acsUrl: string;
  nameIdFormat: SamlNameIdFormat;
  accessTeams: AccessTeamInput[];
  emailAttributeName: string;
  nameAttributeName: string;
  groupsAttributeName: string;
  firstNameAttributeName: string;
  lastNameAttributeName: string;
  signResponse: boolean;
  requireSignedAuthnRequests: boolean;
  spSigningCertificate: string;
  allowIdpInitiated: boolean;
  enabled: boolean;
};

export const identityScopeDescriptions: Record<IdentityScope, string> = {
  openid: "Sign in. Always on.",
  profile: "Name and profile picture",
  email: "Email address",
  groups: "The value set next to each of the person's teams below",
  offline_access: "Stay signed in",
};

export const simpleSamlAttributes = {
  emailAttributeName: samlAppDefaults.emailAttributeName,
  nameAttributeName: samlAppDefaults.nameAttributeName,
  groupsAttributeName: "groups",
  firstNameAttributeName: "",
  lastNameAttributeName: "",
};

/** The claim URIs Microsoft Entra ID and ADFS send, which some apps expect. */
export const microsoftSamlAttributes = {
  emailAttributeName:
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  nameAttributeName:
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
  groupsAttributeName: "http://schemas.xmlsoap.org/claims/Group",
  firstNameAttributeName:
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
  lastNameAttributeName:
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
};

export function newOidcApp(): OidcAppInput {
  return {
    name: "",
    clientType: oidcClientDefaults.clientType,
    accessTeams: [],
    redirectUri: "",
    extraRedirectUris: "",
    postLogoutRedirectUris: "",
    allowedOrigins: "",
    allowedScopes: [...oidcClientDefaults.scopes],
    trusted: oidcClientDefaults.trusted,
    enabled: true,
    requirePkce: oidcClientDefaults.requirePkce,
    backchannelLogoutUri: "",
  };
}

export function newSamlApp(): SamlAppInput {
  return {
    name: "",
    entityId: "",
    acsUrl: "",
    nameIdFormat: samlAppDefaults.nameIdFormat,
    accessTeams: [],
    ...simpleSamlAttributes,
    // Teams are sent only when the admin turns it on.
    groupsAttributeName: "",
    signResponse: samlAppDefaults.signResponse,
    requireSignedAuthnRequests: false,
    spSigningCertificate: "",
    allowIdpInitiated: samlAppDefaults.allowIdpInitiated,
    enabled: true,
  };
}

export function oidcAppFromClient(client: AdminOidcClient): OidcAppInput {
  return {
    name: client.name,
    clientType: client.clientType,
    accessTeams: accessTeamInputs(client.accessTeams),
    redirectUri: client.redirectUris[0] ?? "",
    extraRedirectUris: client.redirectUris.slice(1).join("\n"),
    postLogoutRedirectUris: client.postLogoutRedirectUris.join("\n"),
    allowedOrigins: client.allowedOrigins.join("\n"),
    allowedScopes: client.allowedScopes.filter(isOidcScopeName),
    trusted: client.trusted,
    enabled: client.enabled,
    requirePkce: client.requirePkce,
    backchannelLogoutUri: client.backchannelLogoutUri ?? "",
  };
}

export function samlAppFromApplication(
  application: AdminSamlApplicationDetails
): SamlAppInput {
  return {
    name: application.name,
    entityId: application.entityId,
    acsUrl: application.acsUrl,
    nameIdFormat: application.nameIdFormat,
    accessTeams: accessTeamInputs(application.accessTeams),
    emailAttributeName: application.emailAttributeName,
    nameAttributeName: application.nameAttributeName,
    groupsAttributeName: application.groupsAttributeName ?? "",
    firstNameAttributeName: application.firstNameAttributeName ?? "",
    lastNameAttributeName: application.lastNameAttributeName ?? "",
    signResponse: application.signResponse,
    requireSignedAuthnRequests: application.requireSignedAuthnRequests,
    spSigningCertificate: application.spSigningCertificate ?? "",
    allowIdpInitiated: application.allowIdpInitiated,
    enabled: application.enabled,
  };
}

function accessTeamInputs(
  teams: { teamId: string; sentAs: string | null }[]
): AccessTeamInput[] {
  return teams.map((team) => ({
    teamId: team.teamId,
    sentAs: team.sentAs ?? "",
  }));
}

function accessTeamsPayload(teams: AccessTeamInput[]) {
  return teams.map((team) => ({
    teamId: team.teamId,
    sentAs: team.sentAs.trim() || null,
  }));
}

export function lines(value: string) {
  return [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
    ),
  ];
}

function isHttpsUrl(value: string) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

export function oidcPayload(input: OidcAppInput) {
  return {
    name: input.name.trim(),
    clientType: input.clientType,
    accessTeams: accessTeamsPayload(input.accessTeams),
    redirectUris: lines(
      [input.redirectUri, input.extraRedirectUris].join("\n")
    ),
    postLogoutRedirectUris: lines(input.postLogoutRedirectUris),
    allowedOrigins: lines(input.allowedOrigins),
    allowedScopes: input.allowedScopes,
    trusted: input.trusted,
    enabled: input.enabled,
    requirePkce: pkceRequired(input),
    backchannelLogoutUri: input.backchannelLogoutUri.trim() || null,
  };
}

export function samlPayload(input: SamlAppInput) {
  const optional = (value: string) => value.trim() || null;

  return {
    name: input.name.trim(),
    entityId: input.entityId.trim(),
    acsUrl: input.acsUrl.trim(),
    nameIdFormat: input.nameIdFormat,
    accessTeams: accessTeamsPayload(input.accessTeams),
    emailAttributeName: input.emailAttributeName.trim(),
    nameAttributeName: input.nameAttributeName.trim(),
    groupsAttributeName: optional(input.groupsAttributeName),
    firstNameAttributeName: optional(input.firstNameAttributeName),
    lastNameAttributeName: optional(input.lastNameAttributeName),
    signResponse: input.signResponse,
    requireSignedAuthnRequests: input.requireSignedAuthnRequests,
    spSigningCertificate: optional(input.spSigningCertificate),
    allowIdpInitiated: input.allowIdpInitiated,
    enabled: input.enabled,
  };
}

/** Why the app cannot be saved yet, in words the Save button can show. */
export function oidcSaveProblems(input: OidcAppInput) {
  const problems: string[] = [];

  if (input.name.trim().length < 2) problems.push("Give the app a name");

  if (!input.accessTeams.length) problems.push("Choose who may sign in");

  if (!input.redirectUri.trim()) problems.push("Add the app's redirect URL");

  const redirects = lines(
    [
      input.redirectUri,
      input.extraRedirectUris,
      input.postLogoutRedirectUris,
    ].join("\n")
  );

  if (redirects.some((uri) => !isHttpsUrl(uri) || uri.includes("#"))) {
    problems.push("Redirect URLs must start with https:// and have no #");
  }

  if (
    input.backchannelLogoutUri.trim() &&
    !input.backchannelLogoutUri.trim().startsWith("https://")
  ) {
    problems.push("The sign-out notification URL must start with https://");
  }

  return problems;
}

export function samlSaveProblems(input: SamlAppInput) {
  const problems: string[] = [];

  if (input.name.trim().length < 2) problems.push("Give the app a name");

  if (!input.accessTeams.length) problems.push("Choose who may sign in");

  if (!input.entityId.trim()) problems.push("Add the app's entity ID");
  else if (/\s/u.test(input.entityId.trim())) {
    problems.push("The entity ID cannot contain spaces");
  }

  if (!input.acsUrl.trim()) {
    problems.push("Add the app's sign-in reply (ACS) URL");
  } else if (!isHttpsUrl(input.acsUrl.trim())) {
    problems.push("The ACS URL must start with https://");
  }

  if (!input.emailAttributeName.trim() || !input.nameAttributeName.trim()) {
    problems.push("Name the email and name attributes under Advanced");
  }

  if (input.requireSignedAuthnRequests && !input.spSigningCertificate.trim()) {
    problems.push(
      "Paste the app's signing certificate, or stop requiring signed requests"
    );
  }

  return problems;
}

type TestSignIn = {
  url: string;
  /** What happens, in one sentence under the button. */
  hint: string;
};

/**
 * Trying sign-in from here: an IdP-initiated SAML launch signs straight in;
 * otherwise open the app, since only the app can start the flow.
 */
export function testSignIn(input: {
  /** OIDC: the first redirect URL. SAML: the ACS URL. */
  appUrl: string;
  launchUrl?: string | null;
  allowIdpInitiated?: boolean;
}): TestSignIn | null {
  if (input.launchUrl && input.allowIdpInitiated) {
    return {
      url: input.launchUrl,
      hint: "Signs you in to the app straight from here, as yourself.",
    };
  }

  try {
    return {
      url: new URL(input.appUrl).origin,
      hint: "Opens the app. Choose its single sign-on option; you should come back signed in.",
    };
  } catch {
    return null;
  }
}

export type SsoAppRow =
  | { protocol: "oidc"; app: AdminOidcClient }
  | { protocol: "saml"; app: AdminSamlApplication };
