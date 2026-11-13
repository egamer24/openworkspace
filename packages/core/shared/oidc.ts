export const oidcClientTypes = ["public", "confidential"] as const;

export type OidcClientType = (typeof oidcClientTypes)[number];

export const oidcClientRegistrations = [
  "admin",
  "dynamic",
  "metadata_document",
] as const;

export type OidcClientRegistration = (typeof oidcClientRegistrations)[number];

/**
 * Scopes about the person signing in, for apps that sign people in with
 * OpenID Connect, plus refresh tokens (offline_access).
 */
export const identityScopes = [
  "openid",
  "profile",
  "email",
  "groups",
  "offline_access",
] as const;

export type IdentityScope = (typeof identityScopes)[number];

export function isIdentityScope(scope: string): scope is IdentityScope {
  return identityScopes.some((identityScope) => identityScope === scope);
}

/**
 * Scopes that act on the workspace with an OAuth access token, through the
 * MCP server and the API behind it, or a module's own API. Each is granted
 * at consent and only ever works as far as the person may go themselves:
 * `people.read` and `admin.*` for what they manage, a module's (such as
 * mail's `mail.read`) for what it lets them open. Administration scopes
 * named after a permission come from `PermissionDefinition.scope`; modules
 * declare their others (`WorkspaceModule.oauthScopes`).
 */
/** The administration overview: people, teams and mailboxes. */
export const PEOPLE_READ_SCOPE = "people.read";

/** Workspace settings only administrators change: branding, and which apps may connect. */
export const WORKSPACE_SCOPE = "admin.workspace";

/**
 * Making people administrators, changing what they may manage, and creating
 * recovery and access links: enough to take over accounts. Allowed, with a
 * warning on the consent screen.
 */
export const ACCESS_SCOPE = "admin.access";

/** What every workspace scope looks like: area, a dot, a name. */
export const workspaceScopePattern = /^[a-z][a-z_]*\.[a-z][a-z_]*$/u;

/** Any scope an app may be allowed: identity, or a workspace scope. */
export type OidcScope = IdentityScope | `${string}.${string}`;

export function isOidcScopeName(scope: string): scope is OidcScope {
  return isIdentityScope(scope) || workspaceScopePattern.test(scope);
}

/**
 * Scopes that reach mail, people or administration rather than only
 * identify the person. Only administrators may let an administrator-added
 * app ask for them, and asking for one always shows the consent screen,
 * even for an app that otherwise skips it.
 */
export function isPrivilegedScope(scope: string) {
  return !isIdentityScope(scope);
}

/**
 * Core's scope groups, with what each is called where people read it.
 * Modules add theirs (`WorkspaceModule.oauthScopes`), listed after Your
 * profile.
 */
export const coreScopeGroups = {
  identity: "Your profile",
  people: "People",
  administration: "Administration",
} as const;

/** A scope as people read it: on the consent screen, in settings and administration. */
export type ScopeInfo = {
  id: string;
  /** e.g. "identity", "administration", or a module's group such as "mail". */
  group: string;
  /** What the group is called, e.g. "Mail". */
  groupTitle: string;
  /** The module that declares the scope, for a module's. */
  module?: string;
  label: string;
  /** Could be used to take over accounts; the consent screen warns about it. */
  dangerous: boolean;
};

/**
 * `scopes` grouped as people read them, groups in the order their first
 * scope comes in (the catalog's: Your profile, the modules', People,
 * Administration).
 */
export function groupScopes(scopes: readonly ScopeInfo[]) {
  const groups = new Map<
    string,
    { group: string; title: string; scopes: ScopeInfo[] }
  >();

  for (const scope of scopes) {
    const entry = groups.get(scope.group) ?? {
      group: scope.group,
      title: scope.groupTitle,
      scopes: [],
    };

    entry.scopes.push(scope);
    groups.set(scope.group, entry);
  }

  return [...groups.values()];
}
