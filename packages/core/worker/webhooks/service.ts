import { and, desc, eq, inArray, lt } from "drizzle-orm";

import type { WebhookEventType } from "../../shared/webhooks";
import { createDb } from "../db/client";
import type { Database } from "../db/client";
import type { WebhookEventSource } from "../db/json";
import { mailboxAddressSql, mailboxKind } from "../db/mailboxes";
import {
  webhookDeliveries,
  webhookEndpoints,
  mailboxAccess,
  mailboxes,
  users,
} from "../db/schema";
import { createId } from "../lib/ids";
import type { WebhookEndpointInput } from "./schemas";

const MAX_WEBHOOK_ENDPOINTS = 20;
const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const WEBHOOK_ENQUEUE_ATTEMPTS = 3;

export class WebhookEndpointLimitError extends Error {}

/** A mailbox the person saving an endpoint cannot open, or that does not exist. */
export class WebhookMailboxError extends Error {}

/**
 * The mailboxes whose mail `userId` may route to a webhook: every one for
 * an active administrator, the ones they can open for an active member,
 * none otherwise. Checked when an endpoint is saved and before each mail
 * delivery.
 */
export async function webhookMailboxAccess(db: Database, userId: string) {
  const [user] = await db
    .select({ role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (user?.status !== "active") return { all: false, ids: new Set<string>() };

  if (user.role === "admin") return { all: true, ids: new Set<string>() };

  const rows = await db
    .select({ mailboxId: mailboxAccess.mailboxId })
    .from(mailboxAccess)
    .where(eq(mailboxAccess.userId, userId));

  return { all: false, ids: new Set(rows.map((row) => row.mailboxId)) };
}

/** Whether `owner` may still receive `mailboxId`'s mail through a webhook. */
export async function webhookMayDeliverMailbox(
  db: Database,
  owner: string,
  mailboxId: string
) {
  const access = await webhookMailboxAccess(db, owner);

  if (access.ids.has(mailboxId)) return true;

  if (!access.all) return false;

  const [mailbox] = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId))
    .limit(1);

  return Boolean(mailbox);
}

async function assertMailboxesAllowed(
  db: Database,
  userId: string,
  input: WebhookEndpointInput
) {
  if (!input.mailboxIds.length) return;
  const access = await webhookMailboxAccess(db, userId);

  const existing = new Set(
    (
      await db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(inArray(mailboxes.id, input.mailboxIds))
    ).map((row) => row.id)
  );

  const refused = input.mailboxIds.filter(
    (id) => !existing.has(id) || (!access.all && !access.ids.has(id))
  );

  if (refused.length) {
    throw new WebhookMailboxError("You can only choose mailboxes you can open");
  }
}

/** Core's events carry their payload; a module's carry what its `webhookSources[kind]` builds it from. */
export type { ModuleWebhookSource, WebhookEventSource } from "../db/json";

export type WebhookDispatchJob = {
  type: "dispatch";
  eventId: string;
  eventType: WebhookEventType | "webhook.test";
  occurredAt: number;
  source: WebhookEventSource;
  endpointId?: string;
};

export type WebhookDeliveryJob = {
  type: "deliver";
  deliveryId: string;
};

export type WebhookQueueJob = WebhookDispatchJob | WebhookDeliveryJob;

export function cleanupExpiredWebhookDeliveries(db: Database) {
  return db
    .delete(webhookDeliveries)
    .where(
      lt(
        webhookDeliveries.createdAt,
        new Date(Date.now() - DELIVERY_RETENTION_MS)
      )
    );
}

function publicEndpoint(endpoint: typeof webhookEndpoints.$inferSelect) {
  const { signingSecret: _signingSecret, ...publicFields } = endpoint;

  return publicFields;
}

/** A Standard Webhooks secret: `whsec_` and 32 random bytes in base64. */
export function signingSecret() {
  return `whsec_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))}`;
}

/**
 * The endpoints, their latest deliveries, and the mailboxes `viewerId` may
 * choose for mail events. Each endpoint says which of its mailboxes still
 * get mail: those the person who saved it can still open.
 */
export async function listWebhookSettings(db: Database, viewerId: string) {
  await cleanupExpiredWebhookDeliveries(db);

  const [endpoints, deliveries, mailboxRows, owners, viewerAccess] =
    await Promise.all([
      db.select().from(webhookEndpoints).orderBy(webhookEndpoints.name),
      db
        .select({
          id: webhookDeliveries.id,
          webhookId: webhookDeliveries.webhookId,
          eventId: webhookDeliveries.eventId,
          eventType: webhookDeliveries.eventType,
          status: webhookDeliveries.status,
          attempts: webhookDeliveries.attempts,
          responseStatus: webhookDeliveries.responseStatus,
          responseBody: webhookDeliveries.responseBody,
          error: webhookDeliveries.error,
          lastAttemptAt: webhookDeliveries.lastAttemptAt,
          deliveredAt: webhookDeliveries.deliveredAt,
          createdAt: webhookDeliveries.createdAt,
        })
        .from(webhookDeliveries)
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(50),
      db
        .select({
          id: mailboxes.id,
          address: mailboxAddressSql,
          displayName: mailboxes.displayName,
        })
        .from(mailboxes)
        .orderBy(mailboxes.displayName),
      db.select({ id: users.id, name: users.name }).from(users),
      webhookMailboxAccess(db, viewerId),
    ]);

  const ownerAccess = new Map<
    string,
    Awaited<ReturnType<typeof webhookMailboxAccess>>
  >();

  // Each person who saved an endpoint with mailboxes, once.
  const mailboxOwners = new Set(
    endpoints.flatMap((endpoint) =>
      endpoint.mailboxIds.length ? [endpoint.createdByUserId] : []
    )
  );

  await Promise.all(
    [...mailboxOwners].map(async (owner) => {
      ownerAccess.set(owner, await webhookMailboxAccess(db, owner));
    })
  );

  const mailboxById = new Map(
    mailboxRows.map((mailbox) => [mailbox.id, mailbox])
  );

  return {
    webhooks: endpoints.map((endpoint) => {
      const access = ownerAccess.get(endpoint.createdByUserId);

      return {
        ...publicEndpoint(endpoint),
        savedBy:
          owners.find((owner) => owner.id === endpoint.createdByUserId)?.name ??
          null,
        mailboxes: endpoint.mailboxIds.map((id) => ({
          id,
          address: mailboxById.get(id)?.address ?? null,
          // Mail from it goes out only while whoever saved the endpoint can open it.
          available: Boolean(
            mailboxById.has(id) && access && (access.all || access.ids.has(id))
          ),
        })),
      };
    }),
    deliveries,
    /** What the viewer may choose for mail events. */
    mailboxes: mailboxRows.filter(
      (mailbox) => viewerAccess.all || viewerAccess.ids.has(mailbox.id)
    ),
  };
}

export async function createWebhookEndpoint(
  db: Database,
  createdByUserId: string,
  input: WebhookEndpointInput
) {
  await assertMailboxesAllowed(db, createdByUserId, input);

  const existing = await db
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints);

  if (existing.length >= MAX_WEBHOOK_ENDPOINTS) {
    throw new WebhookEndpointLimitError(
      `An account can have at most ${MAX_WEBHOOK_ENDPOINTS} webhook endpoints`
    );
  }

  const secret = signingSecret();
  const now = new Date();

  const endpoint = {
    id: createId("whk"),
    ...input,
    signingSecret: secret,
    managedBy: null,
    createdByUserId,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(webhookEndpoints).values(endpoint);

  return { webhook: publicEndpoint(endpoint), signingSecret: secret };
}

/**
 * Saves an endpoint as `savedByUserId`, who then answers for its mailboxes:
 * each must be one they can open, and its mail follows their access.
 */
export async function updateWebhookEndpoint(
  db: Database,
  id: string,
  savedByUserId: string,
  input: WebhookEndpointInput
) {
  await assertMailboxesAllowed(db, savedByUserId, input);

  const [endpoint] = await db
    .update(webhookEndpoints)
    .set({ ...input, createdByUserId: savedByUserId, updatedAt: new Date() })
    .where(eq(webhookEndpoints.id, id))
    .returning();

  return endpoint ? publicEndpoint(endpoint) : null;
}

export async function deleteWebhookEndpoint(db: Database, id: string) {
  const deleted = await db
    .delete(webhookEndpoints)
    .where(eq(webhookEndpoints.id, id))
    .returning({ id: webhookEndpoints.id });

  return deleted.length > 0;
}

export async function rotateWebhookSecret(db: Database, id: string) {
  const secret = signingSecret();

  const [endpoint] = await db
    .update(webhookEndpoints)
    .set({ signingSecret: secret, updatedAt: new Date() })
    .where(eq(webhookEndpoints.id, id))
    .returning();

  return endpoint
    ? { webhook: publicEndpoint(endpoint), signingSecret: secret }
    : null;
}

export function queueWebhookEvent(
  env: Env,
  input: Omit<WebhookDispatchJob, "type">
) {
  return env.WEBHOOKS.send({
    type: "dispatch",
    ...input,
  } satisfies WebhookDispatchJob);
}

/**
 * Runs `task` until it succeeds, at most `WEBHOOK_ENQUEUE_ATTEMPTS` times.
 * Queue ingress stays isolated from the operation that produced the event,
 * but brief producer failures get more than one chance.
 */
async function queueWithRetries<Result>(
  task: (eventId: string) => Promise<Result>,
  eventId: string,
  attempt = 1
): Promise<void> {
  try {
    await task(eventId);
  } catch (error) {
    if (attempt < WEBHOOK_ENQUEUE_ATTEMPTS) {
      return queueWithRetries(task, eventId, attempt + 1);
    }

    console.error("Could not queue webhook event", error);
  }
}

export function deferWebhookTask<Result>(
  defer: (task: Promise<unknown>) => void,
  task: (eventId: string) => Promise<Result>
) {
  defer(queueWithRetries(task, createId("evt")));
}

async function userWebhookData(db: Database, userId: string) {
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      status: users.status,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
      email: mailboxAddressSql,
    })
    .from(users)
    .leftJoin(
      mailboxes,
      and(eq(mailboxes.ownerUserId, users.id), eq(mailboxes.isPrimary, true))
    )
    .where(eq(users.id, userId))
    .limit(1);

  return user
    ? {
        ...user,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
      }
    : null;
}

export async function queueUserWebhookEvent(
  env: Env,
  eventType: "user.joined" | "user.updated",
  userId: string,
  eventId: string
) {
  const user = await userWebhookData(createDb(env.DB), userId);

  if (!user) return;
  await queueWebhookEvent(env, {
    eventId,
    eventType,
    occurredAt: Date.now(),
    source: { kind: "data", data: { user } },
  });
}

export async function mailboxWebhookData(db: Database, mailboxId: string) {
  const [mailbox, members] = await Promise.all([
    db
      .select({
        id: mailboxes.id,
        address: mailboxAddressSql,
        displayName: mailboxes.displayName,
        ownerUserId: mailboxes.ownerUserId,
        teamId: mailboxes.teamId,
        delivery: mailboxes.delivery,
        isPrimary: mailboxes.isPrimary,
        aliasOf: mailboxes.aliasOf,
        forwardTo: mailboxes.forwardTo,
        catchAll: mailboxes.catchAll,
        domain: mailboxes.domain,
        createdAt: mailboxes.createdAt,
        updatedAt: mailboxes.updatedAt,
      })
      .from(mailboxes)
      .where(eq(mailboxes.id, mailboxId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({
        userId: mailboxAccess.userId,
        canSend: mailboxAccess.canSend,
      })
      .from(mailboxAccess)
      .where(eq(mailboxAccess.mailboxId, mailboxId)),
  ]);

  return mailbox
    ? {
        ...mailbox,
        kind: mailboxKind(mailbox.ownerUserId),
        createdAt: mailbox.createdAt.toISOString(),
        updatedAt: mailbox.updatedAt.toISOString(),
        members,
      }
    : null;
}

export async function queueMailboxWebhookEvent(
  env: Env,
  eventType: "mailbox.created" | "mailbox.updated" | "mailbox.deleted",
  mailbox: NonNullable<Awaited<ReturnType<typeof mailboxWebhookData>>>,
  eventId: string
) {
  await queueWebhookEvent(env, {
    eventId,
    eventType,
    occurredAt: Date.now(),
    source: { kind: "data", data: { mailbox } },
  });
}

export function queueWebhookTest(env: Env, endpointId: string) {
  const now = Date.now();

  return queueWebhookEvent(env, {
    eventId: createId("evt"),
    eventType: "webhook.test",
    occurredAt: now,
    endpointId,
    source: {
      kind: "data",
      data: {
        message: "OpenWorkspace webhook test",
        sentAt: new Date(now).toISOString(),
      },
    },
  });
}
