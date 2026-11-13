import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";

import { createDb } from "../db/client";
import { webhookSourceSchema } from "../db/json";
import type { WebhookEventSource } from "../db/json";
import { webhookDeliveries, webhookEndpoints } from "../db/schema";
import { nonEmptyBatch } from "../lib/batch";
import { hashToken } from "../lib/crypto";
import { consumeInOrder } from "../lib/queue";
import { readBounded } from "../lib/stream";
import {
  isMailboxEvent,
  workspaceModules,
  workspaceWebhookEvents,
} from "../modules";
import { syncDeclaredWebhooks } from "./declared";
import type { WebhookDeliveryJob, WebhookDispatchJob } from "./service";
import {
  cleanupExpiredWebhookDeliveries,
  webhookMayDeliverMailbox,
} from "./service";

const MAX_DELIVERY_ATTEMPTS = 5;
const RESPONSE_EXCERPT_BYTES = 2048;

class WebhookHttpError extends Error {
  constructor(
    readonly responseStatus: number,
    readonly responseBody: string
  ) {
    super(`Endpoint returned HTTP ${responseStatus}`);
    this.name = "WebhookHttpError";
  }
}

const webhookDispatchJobSchema = z.object({
  type: z.literal("dispatch"),
  eventId: z.string().min(1),
  eventType: z
    .string()
    .refine(
      (event) => event === "webhook.test" || event in workspaceWebhookEvents(),
      "Unknown webhook event"
    ),
  occurredAt: z.number().int().nonnegative(),
  source: webhookSourceSchema,
  endpointId: z.string().min(1).optional(),
});

const webhookDeliveryJobSchema = z.object({
  type: z.literal("deliver"),
  deliveryId: z.string().min(1),
});

const webhookQueueJobSchema = z.discriminatedUnion("type", [
  webhookDispatchJobSchema,
  webhookDeliveryJobSchema,
]);

async function eventData(env: Env, source: WebhookEventSource) {
  if (source.kind === "data") return source.data;

  const [build] = workspaceModules().flatMap((module) => {
    const builder = module.webhookSources?.[source.kind];

    return builder ? [builder] : [];
  });

  if (!build) {
    throw new Error(`No module builds webhook events from ${source.kind}`);
  }

  return await build(env, source);
}

/**
 * A mailbox event's mail goes only to an endpoint that names its mailbox,
 * while the person who saved the endpoint can still open it. Endpoints
 * declared in alchemy.run.ts cover every mailbox. Other events are not
 * about a mailbox's mail.
 */
async function mayReceive(
  db: ReturnType<typeof createDb>,
  endpoint: typeof webhookEndpoints.$inferSelect,
  eventType: string,
  source: WebhookEventSource
) {
  if (!isMailboxEvent(eventType) || endpoint.managedBy) return true;

  const mailboxId = ("mailboxId" in source && source.mailboxId) || null;

  return (
    mailboxId !== null &&
    endpoint.mailboxIds.includes(mailboxId) &&
    (await webhookMayDeliverMailbox(db, endpoint.createdByUserId, mailboxId))
  );
}

async function deliveryId(eventId: string, endpointId: string) {
  const digest = await hashToken(`${eventId}\0${endpointId}`);

  return `whd_${digest.slice(0, 40)}`;
}

async function dispatch(env: Env, job: WebhookDispatchJob) {
  await syncDeclaredWebhooks(env);
  const db = createDb(env.DB);

  const endpointRows = job.endpointId
    ? await db
        .select()
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.id, job.endpointId))
    : await db.select().from(webhookEndpoints);

  const interested = endpointRows.filter((endpoint) =>
    job.eventType === "webhook.test"
      ? endpoint.id === job.endpointId
      : endpoint.enabled && endpoint.events.includes(job.eventType)
  );

  const receives = await Promise.all(
    interested.map((endpoint) =>
      mayReceive(db, endpoint, job.eventType, job.source)
    )
  );

  const subscribed = interested.filter((_endpoint, index) => receives[index]);

  const deliveries = await Promise.all(
    subscribed.map(async (endpoint) => ({
      id: await deliveryId(job.eventId, endpoint.id),
      webhookId: endpoint.id,
      eventId: job.eventId,
      eventType: job.eventType,
      source: job.source,
      createdAt: new Date(job.occurredAt),
    }))
  );

  const inserts = nonEmptyBatch(
    deliveries.map((delivery) =>
      db.insert(webhookDeliveries).values(delivery).onConflictDoNothing()
    )
  );

  // No endpoint gets this event.
  if (!inserts) return;
  await db.batch(inserts);
  await env.WEBHOOKS.sendBatch(
    deliveries.map((delivery) => ({
      body: {
        type: "deliver",
        deliveryId: delivery.id,
      } satisfies WebhookDeliveryJob,
    }))
  );

  try {
    // Retention is housekeeping; a cleanup failure must not retry a dispatch
    // after its delivery jobs have already been queued.
    await cleanupExpiredWebhookDeliveries(db);
  } catch (error) {
    console.error("Could not clean up expired webhook deliveries", error);
  }
}

/**
 * Standard Webhooks (standardwebhooks.com): HMAC-SHA256 with the secret's
 * base64 bytes over `id.timestamp.body`, sent as `v1,<base64>`.
 */
async function standardWebhookSignature(
  secret: string,
  id: string,
  timestamp: string,
  body: string
) {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(secret.replace(/^whsec_/u, "")), (character) =>
      character.charCodeAt(0)
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`)
  );

  return `v1,${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;
}

async function responseExcerpt(response: Response) {
  const { bytes } = await readBounded(response.body, RESPONSE_EXCERPT_BYTES);

  return new TextDecoder().decode(bytes);
}

async function deliver(env: Env, job: WebhookDeliveryJob, attempt: number) {
  const db = createDb(env.DB);

  const [record] = await db
    .select({ delivery: webhookDeliveries, endpoint: webhookEndpoints })
    .from(webhookDeliveries)
    .innerJoin(
      webhookEndpoints,
      eq(webhookDeliveries.webhookId, webhookEndpoints.id)
    )
    .where(eq(webhookDeliveries.id, job.deliveryId))
    .limit(1);

  if (!record || record.delivery.status !== "pending") return;

  const [claimed] = await db
    .update(webhookDeliveries)
    .set({ attempts: attempt, lastAttemptAt: new Date() })
    .where(
      and(
        eq(webhookDeliveries.id, job.deliveryId),
        eq(webhookDeliveries.status, "pending"),
        lt(webhookDeliveries.attempts, attempt)
      )
    )
    .returning({ id: webhookDeliveries.id });

  if (!claimed) return;

  const isTest = record.delivery.eventType === "webhook.test";

  const stillSubscribed = record.endpoint.events.some(
    (event) => event === record.delivery.eventType
  );

  if (!isTest && (!record.endpoint.enabled || !stillSubscribed)) {
    await db
      .update(webhookDeliveries)
      .set({
        status: "failed",
        error: record.endpoint.enabled
          ? "Webhook endpoint no longer subscribes to this event"
          : "Webhook endpoint is disabled",
      })
      .where(
        and(
          eq(webhookDeliveries.id, job.deliveryId),
          eq(webhookDeliveries.status, "pending"),
          eq(webhookDeliveries.attempts, attempt)
        )
      );

    return;
  }

  const parsedSource = webhookSourceSchema.safeParse(record.delivery.source);

  if (!parsedSource.success) throw new Error("Webhook event source is invalid");

  // Checked again now: access may have been lost since the event was queued.
  if (
    !isTest &&
    !(await mayReceive(
      db,
      record.endpoint,
      record.delivery.eventType,
      parsedSource.data
    ))
  ) {
    await db
      .update(webhookDeliveries)
      .set({
        status: "failed",
        error:
          "Not sent: whoever saved this endpoint can no longer open the mailbox, or it was removed from the endpoint",
      })
      .where(
        and(
          eq(webhookDeliveries.id, job.deliveryId),
          eq(webhookDeliveries.status, "pending"),
          eq(webhookDeliveries.attempts, attempt)
        )
      );

    return;
  }

  const payload = JSON.stringify({
    id: record.delivery.eventId,
    type: record.delivery.eventType,
    createdAt: record.delivery.createdAt.toISOString(),
    data: await eventData(env, parsedSource.data),
  });

  const timestamp = Math.floor(Date.now() / 1000).toString();

  // The delivery id stays the same across retries, so receivers can deduplicate.
  const signature = await standardWebhookSignature(
    record.endpoint.signingSecret,
    record.delivery.id,
    timestamp,
    payload
  );

  const response = await fetch(record.endpoint.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "OpenWorkspace-Webhooks/1.0",
      "webhook-id": record.delivery.id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature,
    },
    body: payload,
    // Never followed: a redirect is a failed delivery (Workers has no "error" mode).
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });

  const excerpt = await responseExcerpt(response);

  if (!response.ok) {
    throw new WebhookHttpError(response.status, excerpt);
  }

  await db
    .update(webhookDeliveries)
    .set({
      status: "delivered",
      attempts: attempt,
      responseStatus: response.status,
      responseBody: excerpt || null,
      error: null,
      lastAttemptAt: new Date(),
      deliveredAt: new Date(),
    })
    .where(
      and(
        eq(webhookDeliveries.id, job.deliveryId),
        eq(webhookDeliveries.status, "pending"),
        eq(webhookDeliveries.attempts, attempt)
      )
    );
}

async function recordFailure(
  env: Env,
  deliveryIdValue: string,
  attempt: number,
  cause: unknown
) {
  const final = attempt >= MAX_DELIVERY_ATTEMPTS;

  const responseStatus =
    cause instanceof WebhookHttpError ? cause.responseStatus : null;

  const responseBody =
    cause instanceof WebhookHttpError ? cause.responseBody || null : null;

  const updated = await createDb(env.DB)
    .update(webhookDeliveries)
    .set({
      status: final ? "failed" : "pending",
      attempts: attempt,
      responseStatus,
      responseBody,
      error: (cause instanceof Error ? cause.message : "Delivery failed").slice(
        0,
        2000
      ),
      lastAttemptAt: new Date(),
    })
    .where(
      and(
        eq(webhookDeliveries.id, deliveryIdValue),
        eq(webhookDeliveries.status, "pending"),
        eq(webhookDeliveries.attempts, attempt)
      )
    )
    .returning({ id: webhookDeliveries.id });

  return final || updated.length === 0;
}

export function consumeWebhooks(batch: MessageBatch, env: Env) {
  // A delivery materializes the complete email body from R2, so deliveries
  // run one at a time: a queue batch never holds several large payloads.
  return consumeInOrder(batch, {
    queueName: "webhook",
    schema: webhookQueueJobSchema,
    run: (job, attempts) =>
      job.type === "dispatch"
        ? dispatch(env, job)
        : deliver(env, job, attempts),
    // A delivery records each failure; its last attempt is final.
    settled: async (job, cause, attempts) =>
      job.type === "deliver" &&
      (await recordFailure(env, job.deliveryId, attempts, cause)),
    retryBaseSeconds: 10,
  });
}
