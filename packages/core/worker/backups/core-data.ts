import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { required } from "../../shared/invariant";
import {
  listPostingPolicies,
  mailboxDeliveries,
  workspaceLogo,
} from "../../shared/workspace";
import type { Database } from "../db/client";
import { mailboxAddressSql } from "../db/mailboxes";
import {
  mailboxes,
  oidcClientAccessTeams,
  oidcClients,
  samlApplicationAccessTeams,
  samlApplications,
  settings,
  teamMembers,
  teams,
  users,
  webhookEndpoints,
} from "../db/schema";
import { randomToken } from "../lib/crypto";
import { createId, mailboxAddressParts } from "../lib/ids";
import { newImageKey, sniffImageType, storeImage } from "../lib/stored-image";
import { workspaceWebhookEvents } from "../modules";
import {
  loadBranding,
  LOGO_ID_KEY,
  logoObjectKey,
  NAME_KEY,
} from "../workspace-branding";

/**
 * core.json of a snapshot: what sets the workspace up again. Sessions,
 * passkeys, tokens, OIDC client secrets, webhook signing secrets and SCIM
 * tokens are never selected. Apps and webhooks declared in alchemy.run.ts
 * are left out: the deploy declares them again.
 */

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";

  for (let index = 0; index < bytes.length; index += 0x80_00) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x80_00));
  }

  return btoa(binary);
}

export async function coreBackup(env: Env, db: Database) {
  const [
    people,
    teamRows,
    memberRows,
    addresses,
    oidc,
    oidcTeams,
    saml,
    samlTeams,
    webhooks,
    branding,
  ] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        role: users.role,
        status: users.status,
        permissions: users.permissions,
      })
      .from(users)
      .orderBy(asc(users.id)),
    db
      .select({
        id: teams.id,
        name: teams.name,
        slug: teams.slug,
        description: teams.description,
        everyone: teams.everyone,
      })
      .from(teams)
      .orderBy(asc(teams.id)),
    db
      .select({
        teamId: teamMembers.teamId,
        userId: teamMembers.userId,
        canSend: teamMembers.canSend,
      })
      .from(teamMembers),
    db
      .select({
        id: mailboxes.id,
        address: mailboxAddressSql,
        displayName: mailboxes.displayName,
        ownerUserId: mailboxes.ownerUserId,
        teamId: mailboxes.teamId,
        delivery: mailboxes.delivery,
        listPosting: mailboxes.listPosting,
        isPrimary: mailboxes.isPrimary,
      })
      .from(mailboxes)
      .orderBy(asc(mailboxes.id)),
    db
      .select({
        id: oidcClients.id,
        name: oidcClients.name,
        clientType: oidcClients.clientType,
        redirectUris: oidcClients.redirectUris,
        postLogoutRedirectUris: oidcClients.postLogoutRedirectUris,
        backchannelLogoutUri: oidcClients.backchannelLogoutUri,
        allowedOrigins: oidcClients.allowedOrigins,
        allowedScopes: oidcClients.allowedScopes,
        trusted: oidcClients.trusted,
        enabled: oidcClients.enabled,
        requirePkce: oidcClients.requirePkce,
      })
      .from(oidcClients)
      // Self-registered MCP clients register again.
      .where(
        and(
          eq(oidcClients.registration, "admin"),
          isNull(oidcClients.managedBy)
        )
      ),
    db.select().from(oidcClientAccessTeams),
    db
      .select({
        id: samlApplications.id,
        name: samlApplications.name,
        entityId: samlApplications.entityId,
        acsUrl: samlApplications.acsUrl,
        nameIdFormat: samlApplications.nameIdFormat,
        emailAttributeName: samlApplications.emailAttributeName,
        nameAttributeName: samlApplications.nameAttributeName,
        groupsAttributeName: samlApplications.groupsAttributeName,
        signResponse: samlApplications.signResponse,
        requireSignedAuthnRequests: samlApplications.requireSignedAuthnRequests,
        spSigningCertificate: samlApplications.spSigningCertificate,
        allowIdpInitiated: samlApplications.allowIdpInitiated,
        firstNameAttributeName: samlApplications.firstNameAttributeName,
        lastNameAttributeName: samlApplications.lastNameAttributeName,
        enabled: samlApplications.enabled,
      })
      .from(samlApplications)
      .where(isNull(samlApplications.managedBy)),
    db.select().from(samlApplicationAccessTeams),
    db
      .select({
        id: webhookEndpoints.id,
        name: webhookEndpoints.name,
        url: webhookEndpoints.url,
        events: webhookEndpoints.events,
        mailboxIds: webhookEndpoints.mailboxIds,
      })
      .from(webhookEndpoints)
      .where(isNull(webhookEndpoints.managedBy)),
    loadBranding(db),
  ]);

  const logo = branding.logoId
    ? await env.MEDIA.get(logoObjectKey(branding.logoId))
    : null;

  return {
    version: 1 as const,
    people,
    teams: teamRows.map((team) => ({
      ...team,
      members: memberRows
        .filter((member) => member.teamId === team.id)
        .map(({ userId, canSend }) => ({ userId, canSend })),
    })),
    addresses,
    ssoApps: {
      oidc: oidc.map((client) => ({
        ...client,
        accessTeams: oidcTeams
          .filter((row) => row.clientId === client.id)
          .map(({ teamId, sentAs }) => ({ teamId, sentAs })),
      })),
      saml: saml.map((app) => ({
        ...app,
        accessTeams: samlTeams
          .filter((row) => row.applicationId === app.id)
          .map(({ teamId, sentAs }) => ({ teamId, sentAs })),
      })),
    },
    webhooks,
    branding: {
      name: branding.name,
      logo: logo
        ? bytesToBase64(new Uint8Array(await logo.arrayBuffer()))
        : null,
    },
  };
}

const id = z.string().min(1).max(100);
const name = z.string().min(1).max(500);
const strings = z.array(z.string().max(2000)).max(100);

const accessTeams = z.array(
  z.object({ teamId: id, sentAs: z.string().nullable() })
);

/** core.json as `import backup` sends it back. */
export const coreBackupSchema = z.object({
  version: z.literal(1),
  people: z.array(
    z.object({
      id,
      name,
      role: z.enum(["admin", "member"]),
      status: z.enum(["invited", "active", "disabled"]),
      permissions: strings,
    })
  ),
  teams: z.array(
    z.object({
      id,
      name,
      slug: name,
      description: z.string().max(2000).nullable(),
      everyone: z.boolean(),
      members: z.array(z.object({ userId: id, canSend: z.boolean() })),
    })
  ),
  addresses: z.array(
    z.object({
      id,
      address: z.string().min(3).max(320),
      displayName: name,
      ownerUserId: id.nullable(),
      teamId: id.nullable(),
      delivery: z.enum(mailboxDeliveries),
      listPosting: z.enum(listPostingPolicies),
      isPrimary: z.boolean(),
    })
  ),
  ssoApps: z.object({
    oidc: z.array(
      z.object({
        id,
        name,
        clientType: z.enum(["public", "confidential"]),
        redirectUris: strings,
        postLogoutRedirectUris: strings,
        backchannelLogoutUri: z.string().max(2000).nullable(),
        allowedOrigins: strings,
        allowedScopes: strings,
        trusted: z.boolean(),
        enabled: z.boolean(),
        requirePkce: z.boolean(),
        accessTeams,
      })
    ),
    saml: z.array(
      z.object({
        id,
        name,
        entityId: z.string().min(1).max(2000),
        acsUrl: z.string().min(1).max(2000),
        nameIdFormat: z.enum(["email", "persistent"]),
        emailAttributeName: name,
        nameAttributeName: name,
        groupsAttributeName: name.nullable(),
        signResponse: z.boolean(),
        requireSignedAuthnRequests: z.boolean(),
        spSigningCertificate: z.string().max(20_000).nullable(),
        allowIdpInitiated: z.boolean(),
        firstNameAttributeName: name.nullable(),
        lastNameAttributeName: name.nullable(),
        enabled: z.boolean(),
        accessTeams,
      })
    ),
  }),
  webhooks: z.array(
    z.object({
      id,
      name,
      url: z.string().min(1).max(2000),
      events: strings,
      mailboxIds: strings,
    })
  ),
  branding: z.object({
    name: z.string().max(200).nullable(),
    logo: z.string().max(2_000_000).nullable(),
  }),
});

export type CoreBackup = z.infer<typeof coreBackupSchema>;

/**
 * Puts core.json back: people (invited again, since passkeys can't be
 * restored), teams, addresses (with new ids), SSO apps, webhooks and
 * branding. Anything that exists, by id or by its unique name (an address,
 * a team's handle, a SAML entity id), is left as it is. Restored webhooks get a new signing
 * secret and stay off; restored confidential OIDC clients have no secret
 * until one is rotated.
 */
export async function restoreCoreBackup(
  env: Env,
  db: Database,
  backup: CoreBackup,
  actorUserId: string
) {
  const [userRows, teamRows, addressRows, oidcRows, samlRows, webhookRows] =
    await Promise.all([
      db.select({ id: users.id }).from(users),
      db.select({ id: teams.id, slug: teams.slug }).from(teams),
      db
        .select({ id: mailboxes.id, address: mailboxAddressSql })
        .from(mailboxes),
      db.select({ id: oidcClients.id }).from(oidcClients),
      db
        .select({
          id: samlApplications.id,
          entityId: samlApplications.entityId,
        })
        .from(samlApplications),
      db.select({ id: webhookEndpoints.id }).from(webhookEndpoints),
    ]);

  const taken = new Set([
    ...userRows.map((row) => row.id),
    ...teamRows.flatMap((row) => [row.id, `slug:${row.slug}`]),
    ...addressRows.flatMap((row) => [row.id, `address:${row.address}`]),
    ...oidcRows.map((row) => row.id),
    ...samlRows.flatMap((row) => [row.id, `entity:${row.entityId}`]),
    ...webhookRows.map((row) => row.id),
  ]);

  const primaryOf = new Map(
    backup.addresses.flatMap((address) =>
      address.isPrimary && address.ownerUserId
        ? [[address.ownerUserId, address.address]]
        : []
    )
  );

  // A person whose primary address is taken is someone already here.
  const people = backup.people.filter(
    (person) =>
      !taken.has(person.id) && !taken.has(`address:${primaryOf.get(person.id)}`)
  );

  const newTeams = backup.teams.filter(
    (team) => !taken.has(team.id) && !taken.has(`slug:${team.slug}`)
  );

  const restoredPeople = new Set(people.map((person) => person.id));

  const userIds = new Set([
    ...userRows.map((row) => row.id),
    ...restoredPeople,
  ]);

  const teamIds = new Set([
    ...teamRows.map((row) => row.id),
    ...newTeams.map((team) => team.id),
  ]);

  const addresses = backup.addresses.filter(
    (address) =>
      !taken.has(address.id) &&
      !taken.has(`address:${address.address}`) &&
      (address.ownerUserId === null || userIds.has(address.ownerUserId)) &&
      (address.teamId === null || teamIds.has(address.teamId))
  );

  // A new id, so a module never finds what it kept for a deleted address
  // under the restored one (mail's Durable Object, say).
  const mailboxIds = new Map(
    addresses.map((address) => [address.id, createId("mbx")])
  );

  const oidc = backup.ssoApps.oidc.filter((client) => !taken.has(client.id));

  const saml = backup.ssoApps.saml.filter(
    (app) => !taken.has(app.id) && !taken.has(`entity:${app.entityId}`)
  );

  const webhooks = backup.webhooks.filter((webhook) => !taken.has(webhook.id));
  const events = new Set(Object.keys(workspaceWebhookEvents()));
  const now = new Date();

  // ponytail: one statement a row in one D1 batch, which fits a workspace
  // of some hundreds of people; thousands would need several batches.
  const statements = [
    ...people.map((person) =>
      db.insert(users).values({
        id: person.id,
        name: person.name,
        role: person.role,
        status: person.status === "disabled" ? "disabled" : "invited",
        permissions: person.permissions,
        createdAt: now,
        updatedAt: now,
      })
    ),
    ...newTeams.flatMap(({ members, ...team }) => [
      db.insert(teams).values({ ...team, createdByUserId: actorUserId }),
      ...members
        .filter((member) => userIds.has(member.userId))
        .map((member) =>
          db.insert(teamMembers).values({ teamId: team.id, ...member })
        ),
    ]),
    ...addresses.map(({ id: oldId, address, ...mailbox }) =>
      db.insert(mailboxes).values({
        ...mailbox,
        id: required(mailboxIds.get(oldId), "every restored address has an id"),
        ...mailboxAddressParts(address),
        // Someone already here keeps their own primary address.
        isPrimary:
          mailbox.isPrimary && restoredPeople.has(mailbox.ownerUserId ?? ""),
        createdByUserId: actorUserId,
      })
    ),
    ...oidc.flatMap(({ accessTeams: access, ...client }) => [
      db
        .insert(oidcClients)
        .values({ ...client, createdByUserId: actorUserId }),
      ...access
        .filter((row) => teamIds.has(row.teamId))
        .map((row) =>
          db
            .insert(oidcClientAccessTeams)
            .values({ clientId: client.id, ...row })
        ),
    ]),
    ...saml.flatMap(({ accessTeams: access, ...app }) => [
      db
        .insert(samlApplications)
        .values({ ...app, createdByUserId: actorUserId }),
      ...access
        .filter((row) => teamIds.has(row.teamId))
        .map((row) =>
          db
            .insert(samlApplicationAccessTeams)
            .values({ applicationId: app.id, ...row })
        ),
    ]),
    ...webhooks.map((webhook) =>
      db.insert(webhookEndpoints).values({
        ...webhook,
        events: webhook.events.filter((event) => events.has(event)),
        mailboxIds: webhook.mailboxIds.map(
          (mailboxId) => mailboxIds.get(mailboxId) ?? mailboxId
        ),
        // Off until an administrator rotates the secret and turns it on.
        enabled: false,
        signingSecret: randomToken(),
        createdByUserId: actorUserId,
      })
    ),
  ];

  const [first, ...rest] = statements;

  // One batch, one transaction: all of it lands, or none.
  if (first) await db.batch([first, ...rest]);

  return {
    people: people.length,
    teams: newTeams.length,
    addresses: addresses.length,
    ssoApps: oidc.length + saml.length,
    webhooks: webhooks.length,
    branding: await restoreBranding(env, db, backup.branding),
  };
}

/** The name and logo, where the workspace has none. */
async function restoreBranding(
  env: Env,
  db: Database,
  backup: CoreBackup["branding"]
) {
  const current = await loadBranding(db);
  let restored = false;

  if (backup.name && !current.name) {
    await db
      .insert(settings)
      .values({ key: NAME_KEY, value: backup.name })
      .onConflictDoNothing();
    restored = true;
  }

  if (backup.logo && !current.logoId) {
    const bytes = Uint8Array.from(atob(backup.logo), (character) =>
      character.charCodeAt(0)
    );

    const type = sniffImageType(bytes, workspaceLogo.types);

    if (type && bytes.byteLength <= workspaceLogo.maxBytes) {
      const logoId = newImageKey();
      await storeImage(env, logoObjectKey(logoId), bytes.buffer, type);
      await db
        .insert(settings)
        .values({ key: LOGO_ID_KEY, value: logoId })
        .onConflictDoNothing();
      restored = true;
    }
  }

  return restored;
}
