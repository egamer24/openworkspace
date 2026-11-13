import { and, asc, eq, inArray, isNotNull, notInArray } from "drizzle-orm";

import { declaredSsoAppsSchema } from "../../shared/sso-declarations";
import type {
  DeclaredAccess,
  DeclaredSsoApp,
  DeclaredOidcClient,
  DeclaredProvisioning,
  DeclaredSamlApp,
} from "../../shared/sso-declarations";
import { pkceRequired } from "../../shared/sso-defaults";
import { createDb } from "../db/client";
import type { Database } from "../db/client";
import {
  oidcClientAccessTeams,
  oidcClients,
  samlApplicationAccessTeams,
  samlApplications,
  scimConnections,
  settings,
  teams,
  users,
} from "../db/schema";
import { hashToken } from "../lib/crypto";
import { createId } from "../lib/ids";
import {
  ENTITY_ID_LOCKED_MESSAGE,
  entityIdLocked,
  lockedEntityId,
} from "../saml/entity-id";
import { requestScimSync } from "../scim/sync";
import { revokeLostOidcAccess } from "./access";

/** Hash of the declarations last applied in full, so isolates skip the writes. */
const APPLIED_KEY = "sso_declarations_applied";

let applied: string | undefined;

/**
 * Keeps the apps declared in alchemy.run.ts (the SSO_APPS binding) in D1:
 * creates and updates them, and removes declared apps that were taken out.
 * Runs once per isolate on the sign-in and admin paths, and hourly.
 */
export async function syncDeclaredSsoApps(env: Env) {
  const source = env.SSO_APPS ?? "[]";

  if (applied === source) return;
  // Concurrent first requests share one run; a failure leaves the apps as
  // they were and is retried by the next request.
  running ??= applyDeclarations(env, source)
    .catch((error) =>
      console.error("Could not apply declared single sign-on apps", error)
    )
    .finally(() => {
      running = undefined;
    });
  await running;
}

let running: Promise<void> | undefined;

/**
 * Saves one declared app and its provisioning. It is complete when its teams
 * exist and it was saved; the SCIM connection that changed needs a sync.
 */
async function applyDeclaredApp(
  db: Database,
  app: DeclaredSsoApp,
  ownerId: string
) {
  const access = await resolveTeams(db, app.access);

  if (app.protocol === "oidc") {
    await upsertOidcClient(db, app, ownerId, access.teams);
  } else if (!(await upsertSamlApp(db, app, ownerId, access.teams))) {
    return { complete: false, scimConnectionId: null };
  }

  return {
    complete: !access.missing,
    scimConnectionId: (await applyProvisioning(db, app)) || null,
  };
}

async function applyDeclarations(env: Env, source: string) {
  const db = createDb(env.DB);
  const fingerprint = await hashToken(source);

  const [stored] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, APPLIED_KEY));

  if (stored?.value === fingerprint) {
    applied = source;

    return;
  }

  const apps = declaredSsoAppsSchema.parse(JSON.parse(source));

  // Apps need an owner; until the first administrator exists nobody could sign in anyway.
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.status, "active")))
    .orderBy(asc(users.createdAt))
    .limit(1);

  if (!owner) return;

  let complete = true;
  const toSync: string[] = [];

  for (const app of apps) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- apps apply in declaration order, so of two that conflict (one SAML Entity ID) the later one is refused
    const result = await applyDeclaredApp(db, app, owner.id);

    if (!result.complete) complete = false;

    if (result.scimConnectionId) toSync.push(result.scimConnectionId);
  }

  const oidcIds = apps
    .filter((app) => app.protocol === "oidc")
    .map((app) => app.id);

  const samlIds = apps
    .filter((app) => app.protocol === "saml")
    .map((app) => app.id);

  await db.batch([
    db
      .delete(oidcClients)
      .where(
        and(
          isNotNull(oidcClients.managedBy),
          ...(oidcIds.length ? [notInArray(oidcClients.id, oidcIds)] : [])
        )
      ),
    db
      .delete(samlApplications)
      .where(
        and(
          isNotNull(samlApplications.managedBy),
          ...(samlIds.length ? [notInArray(samlApplications.id, samlIds)] : [])
        )
      ),
  ]);
  await revokeLostOidcAccess(env);
  await requestScimSync(env, toSync);

  // Teams that do not exist yet are picked up on a later run.
  if (!complete) return;
  await db
    .insert(settings)
    .values({ key: APPLIED_KEY, value: fingerprint, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: fingerprint, updatedAt: new Date() },
    });
  applied = source;
}

/** Forgets what this isolate applied; for tests that change SSO_APPS. */
export function resetDeclaredSsoApps() {
  applied = undefined;
  running = undefined;
}

type AccessTeam = { teamId: string; sentAs: string | null };

/** The teams that give access, by handle or the Everyone team, with their values for the app. */
async function resolveTeams(db: Database, access: DeclaredAccess) {
  if (access === "everyone") {
    const rows = await db
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.everyone, true))
      .limit(1);

    return {
      teams: rows.map((row): AccessTeam => ({ teamId: row.id, sentAs: null })),
      missing: rows.length === 0,
    };
  }

  const wanted: Record<string, string | null> = Array.isArray(access.teams)
    ? Object.fromEntries(access.teams.map((slug) => [slug, null]))
    : access.teams;

  const rows = await db
    .select({ id: teams.id, slug: teams.slug })
    .from(teams)
    .where(inArray(teams.slug, Object.keys(wanted)));

  return {
    teams: rows.map((row): AccessTeam => ({
      teamId: row.id,
      sentAs: wanted[row.slug] ?? null,
    })),
    missing: rows.length < Object.keys(wanted).length,
  };
}

async function upsertOidcClient(
  db: Database,
  app: DeclaredOidcClient,
  ownerId: string,
  accessTeams: AccessTeam[]
) {
  const now = new Date();

  const fields = {
    name: app.name,
    clientType: app.clientType,
    secretHash: app.secretHash,
    redirectUris: app.redirectUris,
    postLogoutRedirectUris: app.postLogoutRedirectUris,
    backchannelLogoutUri: app.backchannelLogoutUri,
    allowedOrigins: app.allowedOrigins,
    allowedScopes: app.scopes,
    trusted: app.trusted,
    requirePkce: pkceRequired(app),
    registration: "admin" as const,
    managedBy: "deployment" as const,
    enabled: true,
    updatedAt: now,
  };

  await db.batch([
    db
      .insert(oidcClients)
      .values({
        id: app.id,
        ...fields,
        createdByUserId: ownerId,
        createdAt: now,
      })
      .onConflictDoUpdate({ target: oidcClients.id, set: fields }),
    db
      .delete(oidcClientAccessTeams)
      .where(eq(oidcClientAccessTeams.clientId, app.id)),
    ...(accessTeams.length
      ? [
          db
            .insert(oidcClientAccessTeams)
            .values(accessTeams.map((team) => ({ clientId: app.id, ...team }))),
        ]
      : []),
  ]);
}

async function upsertSamlApp(
  db: Database,
  app: DeclaredSamlApp,
  ownerId: string,
  accessTeams: AccessTeam[]
) {
  const now = new Date();

  const fields = {
    name: app.name,
    entityId: app.entityId,
    acsUrl: app.acsUrl,
    nameIdFormat: app.nameIdFormat,
    emailAttributeName: app.emailAttributeName,
    nameAttributeName: app.nameAttributeName,
    firstNameAttributeName: app.firstNameAttributeName,
    lastNameAttributeName: app.lastNameAttributeName,
    groupsAttributeName: app.groupsAttributeName,
    signResponse: app.signResponse,
    requireSignedAuthnRequests: app.requireSignedAuthnRequests,
    spSigningCertificate: app.spSigningCertificate,
    allowIdpInitiated: app.allowIdpInitiated,
    managedBy: "deployment" as const,
    enabled: true,
    updatedAt: now,
  };

  try {
    await db.batch([
      db
        .insert(samlApplications)
        .values({
          id: app.id,
          ...fields,
          createdByUserId: ownerId,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: samlApplications.id,
          set: { ...fields, entityId: lockedEntityId(app.entityId) },
        }),
      db
        .delete(samlApplicationAccessTeams)
        .where(eq(samlApplicationAccessTeams.applicationId, app.id)),
      ...(accessTeams.length
        ? [
            db
              .insert(samlApplicationAccessTeams)
              .values(
                accessTeams.map((team) => ({ applicationId: app.id, ...team }))
              ),
          ]
        : []),
    ]);

    return true;
  } catch (error) {
    if (!entityIdLocked(error)) throw error;
    // The app stays as it was; the other declarations still apply, and this
    // one is tried again on every sync until the Entity ID is put back.
    console.error(
      `Declared SAML app ${app.id} (${app.name}) was not updated: ${ENTITY_ID_LOCKED_MESSAGE}`
    );

    return false;
  }
}

/**
 * Stores a declared app's provisioning as the admin UI does (one SCIM
 * connection per app), or removes it when the declaration has none; people
 * already provisioned stay in the app then, as when it is removed by hand.
 * Returns the connection to sync now: one that is on and changed.
 */
async function applyProvisioning(db: Database, app: DeclaredSsoApp) {
  const column =
    app.protocol === "oidc"
      ? scimConnections.oidcClientId
      : scimConnections.samlApplicationId;

  const provisioning: DeclaredProvisioning = app.provisioning;

  const [existing] = await db
    .select()
    .from(scimConnections)
    .where(eq(column, app.id))
    .limit(1);

  if (!provisioning) {
    if (existing) {
      await db
        .delete(scimConnections)
        .where(eq(scimConnections.id, existing.id));
    }

    return null;
  }

  const now = new Date();

  if (!existing) {
    const id = createId("scim");
    await db.insert(scimConnections).values({
      id,
      ...(app.protocol === "oidc"
        ? { oidcClientId: app.id }
        : { samlApplicationId: app.id }),
      ...provisioning,
      createdAt: now,
      updatedAt: now,
    });

    return provisioning.enabled ? id : null;
  }

  if (
    existing.baseUrl === provisioning.baseUrl &&
    existing.token === provisioning.token &&
    existing.enabled === provisioning.enabled
  ) {
    return null;
  }

  await db
    .update(scimConnections)
    .set({ ...provisioning, updatedAt: now })
    .where(eq(scimConnections.id, existing.id));

  return provisioning.enabled ? existing.id : null;
}
