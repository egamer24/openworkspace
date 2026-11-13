import {
  ACCESS_SCOPE,
  coreScopeGroups,
  isIdentityScope,
  PEOPLE_READ_SCOPE,
  WORKSPACE_SCOPE,
} from "../../shared/oidc";
import type { IdentityScope, ScopeInfo } from "../../shared/oidc";
import { effectivePermissions } from "../auth/permissions";
import type { SessionUser } from "../env";
import { workspaceModules, workspacePermissions } from "../modules";

type ScopeUser = Pick<SessionUser, "role" | "permissions">;

/** A scope and who may grant it: the person's role must cover what it does. */
export type ScopeDefinition = ScopeInfo & {
  /** Whether this person may use it now; checked at consent and on every request. */
  covers: (user: ScopeUser) => boolean;
  /** For an administration scope named after a permission, that permission. */
  permission?: string;
};

const everyone = () => true;
const administrators = (user: ScopeUser) => user.role === "admin";

const identityLabels: Record<IdentityScope, string> = {
  openid: "Confirm who you are",
  profile: "See your name and profile picture",
  email: "See your personal email address",
  groups: "See which of the teams that may use this app you are in",
  offline_access: "Stay connected while you are away",
};

const peopleReadScope: ScopeDefinition = {
  id: PEOPLE_READ_SCOPE,
  group: "people",
  groupTitle: coreScopeGroups.people,
  label: "See the people, teams and mailboxes in the workspace",
  dangerous: false,
  // The administration overview is for people who manage something.
  covers: (user) => effectivePermissions(user).length > 0,
};

const administrationScopes: ScopeDefinition[] = [
  {
    id: WORKSPACE_SCOPE,
    group: "administration",
    groupTitle: coreScopeGroups.administration,
    label:
      "Change workspace settings, such as its name and logo and which apps may connect",
    dangerous: false,
    covers: administrators,
  },
  {
    id: ACCESS_SCOPE,
    group: "administration",
    groupTitle: coreScopeGroups.administration,
    label:
      "Make people administrators, change what they may manage, and create account recovery links",
    dangerous: true,
    covers: administrators,
  },
];

/** The ids of core's own workspace scopes, which no module may take. */
export function coreScopeIds() {
  return [peopleReadScope, ...administrationScopes].map((scope) => scope.id);
}

/**
 * Every workspace scope: identity scopes, mail and other scopes the modules
 * declare, the administration overview and settings, and one scope per
 * permission (core's and the modules').
 */
export function scopeDefinitions(): ScopeDefinition[] {
  return [
    ...Object.entries(identityLabels).map(([id, label]) => ({
      id,
      group: "identity",
      groupTitle: coreScopeGroups.identity,
      label,
      dangerous: false,
      covers: everyone,
    })),
    ...workspaceModules().flatMap(({ name, oauthScopes }) =>
      oauthScopes
        ? oauthScopes.scopes.map((scope) => ({
            id: scope.id,
            group: oauthScopes.group,
            groupTitle: oauthScopes.title,
            module: name,
            label: scope.label,
            dangerous: false,
            covers: everyone,
          }))
        : []
    ),
    peopleReadScope,
    ...workspacePermissions().map((permission) => ({
      id: permission.scope,
      group: "administration",
      groupTitle: coreScopeGroups.administration,
      label: permission.description,
      dangerous: false,
      permission: permission.id,
      covers: (user: ScopeUser) =>
        effectivePermissions(user).includes(permission.id),
    })),
    ...administrationScopes,
  ];
}

export function scopeDefinition(id: string) {
  return scopeDefinitions().find((scope) => scope.id === id);
}

/** Whether the workspace knows this scope at all. */
export function isKnownScope(id: string) {
  return Boolean(scopeDefinition(id));
}

/**
 * What a self-registered app (an MCP client) gets when it asks for nothing:
 * the installed modules' everyday scopes (`byDefault`, e.g. reading mail),
 * and refresh tokens so an agent need not sign in every ten minutes.
 * Anything more it has to ask for.
 */
export function defaultSelfRegisteredScopes() {
  return [
    ...workspaceModules().flatMap((module) =>
      (module.oauthScopes?.scopes ?? [])
        .filter((scope) => scope.byDefault)
        .map((scope) => scope.id)
    ),
    "offline_access",
  ];
}

/**
 * The scopes a client is pointed at when it has no token: the modules'
 * everyday scopes and refresh tokens. Administration has to be asked for by
 * name (see scopes_supported).
 */
export function suggestedScopes() {
  return [
    ...workspaceModules().flatMap((module) =>
      (module.oauthScopes?.scopes ?? []).map((scope) => scope.id)
    ),
    "offline_access",
  ];
}

/** Known scopes that act on the workspace, i.e. everything but identity. */
export function workspaceScopeIds() {
  return scopeDefinitions()
    .filter((scope) => scope.group !== "identity")
    .map((scope) => scope.id);
}

/**
 * Of `scopes`, those this person may use right now: identity scopes always,
 * workspace scopes only as far as their role and permissions go. Applied at
 * consent and again to every request a token makes.
 */
export function coveredScopes(user: ScopeUser, scopes: readonly string[]) {
  return scopes.filter(
    (id) => isIdentityScope(id) || scopeDefinition(id)?.covers(user)
  );
}

/** The scope that hands an app `permission`, if any. */
export function permissionScope(permission: string) {
  return workspacePermissions().find((item) => item.id === permission)?.scope;
}

/** Scopes as the consent screen and settings show them, in catalog order. */
export function scopeInfo(ids: readonly string[]): ScopeInfo[] {
  return scopeDefinitions()
    .filter((scope) => ids.includes(scope.id))
    .map(({ id, group, groupTitle, module, label, dangerous }) => {
      const info: ScopeInfo = { id, group, groupTitle, label, dangerous };

      if (module) info.module = module;

      return info;
    });
}
