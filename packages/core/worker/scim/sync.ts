import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";

import { createDb } from "../db/client";
import type { Database } from "../db/client";
import { mailboxAddressSql } from "../db/mailboxes";
import {
  mailboxes,
  oidcClientAccess,
  oidcClientAccessTeams,
  oidcClients,
  samlApplicationAccess,
  samlApplicationAccessTeams,
  samlApplications,
  scimConnections,
  scimResources,
  teamMembership,
  teams,
  users,
} from "../db/schema";
import { hashToken } from "../lib/crypto";
import { jsonValueSchema } from "../lib/json";
import type { JsonValue } from "../lib/json";
import { sendInBatches } from "../lib/queue";

/**
 * SCIM 2.0 (RFC 7643, RFC 7644) provisioning. Each run compares what the
 * application should hold with what this workspace last sent it, and sends
 * only the difference:
 *
 * - people with access are created or updated; people who lose it are
 *   deactivated (active: false), and deleted only once they leave the workspace;
 * - the teams that give access become groups with those people as members
 *   (not the Everyone team, which says nothing about anyone).
 */

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

const LEASE_MS = 5 * 60_000;

/** Requests per run; a larger change continues in the next queue message. */
const REQUESTS_PER_RUN = 200;
const REQUEST_TIMEOUT_MS = 15_000;
const ERROR_EXCERPT_LENGTH = 300;

export type ScimSyncJob = { type: "scim-sync"; connectionId: string };

export class ScimHttpError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
    body: string
  ) {
    super(
      `${method} ${path} returned HTTP ${status}${body ? `: ${body}` : ""}`
    );
    this.name = "ScimHttpError";
  }

  /** The application rejected this one resource; others may still go through. */
  get rejectsResource() {
    return this.status === 400 || this.status === 409 || this.status === 422;
  }
}

class RequestBudgetSpent extends Error {}

export class ScimClient {
  private requests = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly budget = Number.POSITIVE_INFINITY
  ) {}

  /** Sends one request; the answer's JSON, or null when it has none. */
  async send(
    method: string,
    path: string,
    body?: ScimRequestBody
  ): Promise<JsonValue | null> {
    if (this.requests >= this.budget) throw new RequestBudgetSpent();
    this.requests += 1;

    const headers = new Headers({
      authorization: `Bearer ${this.token}`,
      accept: "application/scim+json, application/json",
    });

    if (body !== undefined) {
      headers.set("content-type", "application/scim+json");
    }

    let response: Response;

    try {
      response = await this.fetcher(
        `${this.baseUrl.replace(/\/+$/u, "")}${path}`,
        {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "manual",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }
      );
    } catch (error) {
      throw new Error(
        `${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }

    const text = await response.text();

    if (!response.ok) {
      throw new ScimHttpError(
        response.status,
        method,
        path,
        text.slice(0, ERROR_EXCERPT_LENGTH)
      );
    }

    if (!text) return null;

    try {
      return jsonValueSchema.parse(JSON.parse(text));
    } catch {
      return null;
    }
  }
}

type DesiredUser = { id: string; name: string; email: string };

type DesiredTeam = { id: string; name: string; memberIds: string[] };

type Mapping = typeof scimResources.$inferSelect;

/** RFC 7643 §4.1.1: a User's name, its parts only when known. */
type ScimName = { formatted: string; givenName?: string; familyName?: string };

function userResource(user: DesiredUser) {
  const [givenName, ...rest] = user.name.trim().split(/\s+/u);
  const familyName = rest.join(" ");

  // In this order: the resource's hash is of its JSON.
  const name: ScimName = { formatted: user.name };

  if (givenName) name.givenName = givenName;

  if (familyName) name.familyName = familyName;

  return {
    schemas: [USER_SCHEMA],
    externalId: user.id,
    userName: user.email,
    name,
    displayName: user.name,
    emails: [{ value: user.email, type: "work", primary: true }],
    active: true,
  };
}

function groupResource(team: DesiredTeam, memberRemoteIds: string[]) {
  return {
    schemas: [GROUP_SCHEMA],
    externalId: team.id,
    displayName: team.name,
    members: memberRemoteIds.map((value) => ({ value })),
  };
}

const deactivation = {
  schemas: [PATCH_SCHEMA],
  Operations: [{ op: "replace", value: { active: false } }],
};

type ScimResource =
  | ReturnType<typeof userResource>
  | ReturnType<typeof groupResource>;

type ScimRequestBody = ScimResource | typeof deactivation;

/** A created or found resource: the application's id for it. */
const remoteResourceSchema = z.object({ id: z.string().min(1) });

/** A list response (RFC 7644 §3.4.2); only its first match is used. */
const listResponseSchema = z.object({
  Resources: z.array(jsonValueSchema).optional(),
});

function filterValue(value: string) {
  return `"${value.replaceAll(/["\\]/gu, (character) => `\\${character}`)}"`;
}

function remoteId(body: JsonValue | null | undefined, path: string) {
  const resource = remoteResourceSchema.safeParse(body);

  if (resource.success) return resource.data.id;
  throw new Error(`${path} returned no resource id`);
}

/** Creates a resource, or adopts one the application already has under that name. */
async function createOrAdopt(
  client: ScimClient,
  path: "/Users" | "/Groups",
  resource: ScimResource,
  filter: string
) {
  try {
    return remoteId(await client.send("POST", path, resource), path);
  } catch (error) {
    if (!(error instanceof ScimHttpError) || error.status !== 409) throw error;

    const found = await client.send(
      "GET",
      `${path}?filter=${encodeURIComponent(filter)}`
    );

    const existing = listResponseSchema.safeParse(found).data?.Resources?.[0];

    if (!existing) throw error;
    const id = remoteId(existing, path);
    await client.send("PUT", `${path}/${encodeURIComponent(id)}`, resource);

    return id;
  }
}

/** Replaces a resource, recreating it when the application lost it. */
async function replace(
  client: ScimClient,
  path: "/Users" | "/Groups",
  id: string,
  resource: ScimResource,
  filter: string
) {
  try {
    await client.send("PUT", `${path}/${encodeURIComponent(id)}`, resource);

    return id;
  } catch (error) {
    if (!(error instanceof ScimHttpError) || error.status !== 404) throw error;

    return createOrAdopt(client, path, resource, filter);
  }
}

/** Removes a resource; one that is already gone counts as removed. */
async function remove(
  client: ScimClient,
  path: "/Users" | "/Groups",
  id: string
) {
  try {
    await client.send("DELETE", `${path}/${encodeURIComponent(id)}`);
  } catch (error) {
    if (!(error instanceof ScimHttpError) || error.status !== 404) throw error;
  }
}

function resourceHash(resource: ScimResource) {
  return hashToken(JSON.stringify(resource));
}

type Connection = typeof scimConnections.$inferSelect;

/** The application behind a connection and who it should hold. */
async function desiredState(db: Database, connection: Connection) {
  // A connection belongs to an OIDC client or a SAML app.
  const owner = connection.oidcClientId
    ? ({ protocol: "oidc", id: connection.oidcClientId } as const)
    : connection.samlApplicationId
      ? ({ protocol: "saml", id: connection.samlApplicationId } as const)
      : null;

  if (!owner) return null;

  const [application] =
    owner.protocol === "oidc"
      ? await db
          .select({ enabled: oidcClients.enabled })
          .from(oidcClients)
          .where(eq(oidcClients.id, owner.id))
      : await db
          .select({ enabled: samlApplications.enabled })
          .from(samlApplications)
          .where(eq(samlApplications.id, owner.id));

  if (!application?.enabled) return null;

  const people = db
    .select({ id: users.id, name: users.name, email: mailboxAddressSql })
    .from(users)
    .innerJoin(
      mailboxes,
      and(eq(mailboxes.ownerUserId, users.id), eq(mailboxes.isPrimary, true))
    );

  const desiredUsers: DesiredUser[] =
    owner.protocol === "oidc"
      ? await people
          .innerJoin(oidcClientAccess, eq(oidcClientAccess.userId, users.id))
          .where(eq(oidcClientAccess.clientId, owner.id))
      : await people
          .innerJoin(
            samlApplicationAccess,
            eq(samlApplicationAccess.userId, users.id)
          )
          .where(eq(samlApplicationAccess.applicationId, owner.id));

  const exposedTeams =
    owner.protocol === "oidc"
      ? await db
          .select({ id: teams.id, name: teams.name })
          .from(oidcClientAccessTeams)
          .innerJoin(
            teams,
            and(
              eq(teams.id, oidcClientAccessTeams.teamId),
              eq(teams.everyone, false)
            )
          )
          .where(eq(oidcClientAccessTeams.clientId, owner.id))
      : await db
          .select({ id: teams.id, name: teams.name })
          .from(samlApplicationAccessTeams)
          .innerJoin(
            teams,
            and(
              eq(teams.id, samlApplicationAccessTeams.teamId),
              eq(teams.everyone, false)
            )
          )
          .where(eq(samlApplicationAccessTeams.applicationId, owner.id));

  const memberships = exposedTeams.length
    ? await db
        .select({
          teamId: teamMembership.teamId,
          userId: teamMembership.userId,
        })
        .from(teamMembership)
        .innerJoin(
          users,
          and(eq(users.id, teamMembership.userId), eq(users.status, "active"))
        )
        .where(
          inArray(
            teamMembership.teamId,
            exposedTeams.map((team) => team.id)
          )
        )
    : [];

  const desiredTeams: DesiredTeam[] = exposedTeams.map((team) => ({
    ...team,
    memberIds: memberships
      .filter((membership) => membership.teamId === team.id)
      .map((membership) => membership.userId),
  }));

  return { users: desiredUsers, teams: desiredTeams };
}

function saveMapping(
  db: Database,
  connectionId: string,
  kind: Mapping["kind"],
  localId: string,
  values: { remoteId: string; hash: string; active: boolean }
) {
  const now = new Date();

  return db
    .insert(scimResources)
    .values({ connectionId, kind, localId, ...values, updatedAt: now })
    .onConflictDoUpdate({
      target: [
        scimResources.connectionId,
        scimResources.kind,
        scimResources.localId,
      ],
      set: { ...values, updatedAt: now },
    });
}

function deleteMapping(db: Database, mapping: Mapping) {
  return db
    .delete(scimResources)
    .where(
      and(
        eq(scimResources.connectionId, mapping.connectionId),
        eq(scimResources.kind, mapping.kind),
        eq(scimResources.localId, mapping.localId)
      )
    );
}

/** One resource's change, named for the failure it may record. */
type ScimChange = { label: string; apply: () => Promise<void> };

/**
 * Applies changes one at a time, in order. A change the application
 * rejects is recorded in `failures` and the rest carry on; anything else
 * (a spent request budget, an unreachable server) stops the run.
 */
async function applyInOrder(
  changes: readonly ScimChange[],
  failures: string[]
) {
  for (const change of changes) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one request at a time: the run's request budget counts them, the application's rate limits apply, and groups need the people created before them
      await change.apply();
    } catch (error) {
      if (!(error instanceof ScimHttpError) || !error.rejectsResource) {
        throw error;
      }

      failures.push(`${change.label}: ${error.message}`);
    }
  }
}

/** A person gone from the workspace: their account goes too. */
async function removeUser(db: Database, client: ScimClient, mapping: Mapping) {
  await remove(client, "/Users", mapping.remoteId);
  await deleteMapping(db, mapping);
}

/** A person who lost access but is still in the workspace: deactivated, once. */
async function deactivate(
  db: Database,
  client: ScimClient,
  connectionId: string,
  mapping: Mapping
) {
  if (!mapping.active) return;

  try {
    await client.send(
      "PATCH",
      `/Users/${encodeURIComponent(mapping.remoteId)}`,
      deactivation
    );
  } catch (error) {
    if (!(error instanceof ScimHttpError) || error.status !== 404) {
      throw error;
    }

    await deleteMapping(db, mapping);

    return;
  }

  await saveMapping(db, connectionId, "user", mapping.localId, {
    remoteId: mapping.remoteId,
    hash: "inactive",
    active: false,
  });
}

/**
 * Brings one application up to date. Returns "more" when the request budget
 * ran out first; the caller queues another run.
 */
async function reconcile(
  db: Database,
  connection: Connection,
  client: ScimClient,
  failures: string[]
): Promise<"done" | "more"> {
  const desired = await desiredState(db, connection);

  // A disabled application keeps what it has until it is enabled again.
  if (!desired) return "done";

  const mappings = await db
    .select()
    .from(scimResources)
    .where(eq(scimResources.connectionId, connection.id));

  const userMappings = new Map(
    mappings
      .filter((mapping) => mapping.kind === "user")
      .map((mapping) => [mapping.localId, mapping])
  );

  const groupMappings = new Map(
    mappings
      .filter((mapping) => mapping.kind === "group")
      .map((mapping) => [mapping.localId, mapping])
  );

  try {
    // People first, so groups can refer to them.
    const provisioned = new Map<string, string>();

    const desiredUsers = await Promise.all(
      desired.users.map(async (user) => {
        const resource = userResource(user);

        return { user, resource, hash: await resourceHash(resource) };
      })
    );

    const userChanges = desiredUsers.flatMap(({ user, resource, hash }) => {
      const mapping = userMappings.get(user.id);

      if (mapping?.hash === hash) {
        provisioned.set(user.id, mapping.remoteId);

        return [];
      }

      const filter = `userName eq ${filterValue(user.email)}`;

      return [
        {
          label: user.email,
          apply: async () => {
            const id = mapping
              ? await replace(
                  client,
                  "/Users",
                  mapping.remoteId,
                  resource,
                  filter
                )
              : await createOrAdopt(client, "/Users", resource, filter);

            await saveMapping(db, connection.id, "user", user.id, {
              remoteId: id,
              hash,
              active: true,
            });
            provisioned.set(user.id, id);
          },
        },
      ];
    });

    await applyInOrder(userChanges, failures);

    const desiredUserIds = new Set(desired.users.map((user) => user.id));

    const leaving = [...userMappings.values()].filter(
      (mapping) => !desiredUserIds.has(mapping.localId)
    );

    const stillInWorkspace = new Set(
      leaving.length
        ? (
            await db
              .select({ id: users.id })
              .from(users)
              .where(
                inArray(
                  users.id,
                  leaving.map((mapping) => mapping.localId)
                )
              )
          ).map((user) => user.id)
        : []
    );

    await applyInOrder(
      leaving.map((mapping) => ({
        label: `user ${mapping.remoteId}`,
        apply: () =>
          stillInWorkspace.has(mapping.localId)
            ? deactivate(db, client, connection.id, mapping)
            : removeUser(db, client, mapping),
      })),
      failures
    );

    const groups = await Promise.all(
      desired.teams.map(async (team) => {
        const members = team.memberIds
          .flatMap((userId) => {
            const id = provisioned.get(userId);

            return id ? [id] : [];
          })
          .sort();

        const resource = groupResource(team, members);

        return { team, resource, hash: await resourceHash(resource) };
      })
    );

    const groupChanges = groups.flatMap(
      ({ team, resource, hash }): ScimChange[] => {
        const mapping = groupMappings.get(team.id);

        if (mapping?.hash === hash) return [];
        const filter = `displayName eq ${filterValue(team.name)}`;

        return [
          {
            label: `group ${team.name}`,
            apply: async () => {
              const id = mapping
                ? await replace(
                    client,
                    "/Groups",
                    mapping.remoteId,
                    resource,
                    filter
                  )
                : await createOrAdopt(client, "/Groups", resource, filter);

              await saveMapping(db, connection.id, "group", team.id, {
                remoteId: id,
                hash,
                active: true,
              });
            },
          },
        ];
      }
    );

    await applyInOrder(groupChanges, failures);

    const desiredTeamIds = new Set(desired.teams.map((team) => team.id));

    await applyInOrder(
      [...groupMappings.values()].flatMap((mapping): ScimChange[] =>
        desiredTeamIds.has(mapping.localId)
          ? []
          : [
              {
                label: `group ${mapping.remoteId}`,
                apply: async () => {
                  await remove(client, "/Groups", mapping.remoteId);
                  await deleteMapping(db, mapping);
                },
              },
            ]
      ),
      failures
    );
  } catch (error) {
    if (error instanceof RequestBudgetSpent) return "more";
    throw error;
  }

  return "done";
}

/** Marks connections as needing a sync and queues one for each. */
export async function requestScimSync(env: Env, connectionIds?: string[]) {
  if (connectionIds?.length === 0) return;

  const requested = await createDb(env.DB)
    .update(scimConnections)
    .set({ syncRequestedAt: new Date() })
    .where(
      and(
        eq(scimConnections.enabled, true),
        connectionIds ? inArray(scimConnections.id, connectionIds) : undefined
      )
    )
    .returning({ id: scimConnections.id });

  await sendInBatches(
    env.IDENTITY_SYNC,
    requested.map(({ id }): ScimSyncJob => ({
      type: "scim-sync",
      connectionId: id,
    }))
  );
}

/**
 * Runs one sync of a connection unless another is under way; that one runs
 * again when it finishes, because the request is newer than its start.
 */
export async function syncScimConnection(
  env: Env,
  connectionId: string,
  fetcher: typeof fetch = fetch
) {
  const db = createDb(env.DB);
  const startedAt = new Date();

  const [connection] = await db
    .update(scimConnections)
    .set({ leaseUntil: new Date(startedAt.getTime() + LEASE_MS) })
    .where(
      and(
        eq(scimConnections.id, connectionId),
        eq(scimConnections.enabled, true),
        or(
          isNull(scimConnections.leaseUntil),
          lt(scimConnections.leaseUntil, startedAt)
        )
      )
    )
    .returning();

  if (!connection) return "skipped" as const;

  const failures: string[] = [];
  let outcome: "done" | "more";

  try {
    outcome = await reconcile(
      db,
      connection,
      new ScimClient(
        connection.baseUrl,
        connection.token,
        fetcher,
        REQUESTS_PER_RUN
      ),
      failures
    );
  } catch (error) {
    await db
      .update(scimConnections)
      .set({
        leaseUntil: null,
        lastSyncAt: new Date(),
        lastError: error instanceof Error ? error.message : String(error),
      })
      .where(eq(scimConnections.id, connectionId));
    throw error;
  }

  const finishedAt = new Date();

  const result: Partial<Connection> = {
    leaseUntil: null,
    lastSyncAt: finishedAt,
    lastError: failures.length
      ? `${failures.length} change${failures.length === 1 ? "" : "s"} rejected. ${failures[0]}`
      : null,
  };

  // A run that left changes for the next one has not succeeded yet.
  if (!failures.length && outcome === "done") {
    result.lastSuccessAt = finishedAt;
  }

  const [finished] = await db
    .update(scimConnections)
    .set(result)
    .where(eq(scimConnections.id, connectionId))
    .returning({ syncRequestedAt: scimConnections.syncRequestedAt });

  if (
    outcome === "more" ||
    (finished?.syncRequestedAt && finished.syncRequestedAt > startedAt)
  ) {
    await env.IDENTITY_SYNC.send({
      type: "scim-sync",
      connectionId,
    } satisfies ScimSyncJob);
  }

  return outcome;
}

/** Checks the URL and token by listing one user. */
export async function testScimConnection(
  baseUrl: string,
  token: string,
  fetcher: typeof fetch = fetch
) {
  try {
    await new ScimClient(baseUrl, token, fetcher).send("GET", "/Users?count=1");

    return { reachable: true as const, error: null };
  } catch (error) {
    return {
      reachable: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
