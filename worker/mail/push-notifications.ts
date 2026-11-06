import {
  sendPushNotification,
  topicFromString,
  WebPushError,
} from "@mmmike/web-push/send";
import {
  createVapidJwt,
  urlBase64ToUint8Array,
} from "@mmmike/web-push/vapid";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { CalendarReminderPushJob } from "../../shared/calendar";
import type { MailboxPushJob } from "../../shared/mail";
import { requireSessionAuth } from "../auth/middleware";
import { createDb } from "../db/client";
import {
  domains,
  mailboxMembers,
  mailboxNotificationPreferences,
  mailboxes,
  pushSubscriptions,
  users,
} from "../db/schema";
import { mailboxAddressSql, mailboxKindOrderSql } from "../db/mailboxes";
import type { AppEnv, PushBindings } from "../env";
import { apiError } from "../lib/http";
import { createId } from "../lib/ids";
import { calendarModuleEnabled } from "../calendar/module";
import { mailboxStub } from "../mailbox";
import { getMailboxAccess } from "./access";

export const PUSH_NOTIFICATION_QUEUE = "openworkspace-push-notifications";

const pushSubscriptionSchema = z.object({
  endpoint: z.url().max(4_096).refine(
    (value) => new URL(value).protocol === "https:",
    "Push endpoint must use HTTPS",
  ),
  keys: z.object({
    p256dh: z.string().min(1).max(512).refine((value) => {
      try {
        const key = urlBase64ToUint8Array(value);
        return key.length === 65 && key[0] === 4;
      } catch {
        return false;
      }
    }, "p256dh must be an uncompressed P-256 public key"),
    auth: z.string().min(1).max(512).refine((value) => {
      try {
        return urlBase64ToUint8Array(value).length >= 16;
      } catch {
        return false;
      }
    }, "auth must contain at least 16 bytes"),
  }),
});

const subscriptionEndpointSchema = z.object({
  endpoint: z.string().url().max(4_096),
});

const notificationPreferenceSchema = z.object({ enabled: z.boolean() });

const pushJobBaseSchema = z.object({
  mailboxId: z.string().min(1),
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
  occurredAt: z.number().int().nonnegative(),
  sender: z.string().min(1).max(500),
  subject: z.string().max(998),
});

const pushJobSchema = z.discriminatedUnion("type", [
  pushJobBaseSchema.extend({ type: z.literal("dispatch") }),
  pushJobBaseSchema.extend({
    type: z.literal("deliver"),
    targetSubscriptionId: z.string().min(1),
    mailboxDisplayName: z.string().min(1).max(500),
  }),
]) satisfies z.ZodType<MailboxPushJob>;

const calendarReminderJobSchema = z.object({
  type: z.literal("calendar-reminder"),
  userId: z.string().min(1),
  eventId: z.string().min(1),
  occurrenceStart: z.number().int(),
  occurredAt: z.number().int().nonnegative(),
  title: z.string().max(500),
  body: z.string().max(1_000),
  targetSubscriptionId: z.string().min(1).optional(),
}) satisfies z.ZodType<CalendarReminderPushJob>;

const queuedPushJobSchema = z.union([pushJobSchema, calendarReminderJobSchema]);

const MAX_PUSH_JOB_AGE_MS = 15 * 60 * 1_000;
const MAX_QUEUE_SEND_BATCH_SIZE = 100;

type PushConfiguration = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

type PushConfigurationStatus = {
  configuration: PushConfiguration | null;
  error: string | null;
};

let cachedPushConfiguration: {
  source: string;
  status: Promise<PushConfigurationStatus>;
} | null = null;

class RetryablePushError extends Error {
  constructor(
    readonly delaySeconds: number,
    cause: unknown,
  ) {
    super("Push delivery should be retried", { cause });
  }
}

function retryDelaySeconds(error: unknown) {
  if (
    error instanceof WebPushError
    && error.statusCode !== 408
    && error.statusCode !== 429
    && error.statusCode < 500
  ) {
    return null;
  }
  const timedOut = error instanceof DOMException
    && (error.name === "AbortError" || error.name === "TimeoutError");
  if (
    !(error instanceof WebPushError)
    && !(error instanceof TypeError)
    && !timedOut
  ) {
    return null;
  }
  const delayMs = error instanceof WebPushError
    ? error.retryAfterMs ?? 30_000
    : 30_000;
  return Math.max(1, Math.min(12 * 60 * 60, Math.ceil(delayMs / 1_000)));
}

function pushFailureDetails(error: unknown) {
  if (error instanceof WebPushError) {
    return {
      name: error.name,
      message: error.message,
      statusCode: error.statusCode,
      retryAfterMs: error.retryAfterMs,
    };
  }
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { message: String(error) };
}

function pushConfiguration(env: PushBindings) {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  const subject = env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    return Promise.resolve({
      configuration: null,
      error: null,
    } satisfies PushConfigurationStatus);
  }

  const source = `${publicKey}\0${privateKey}\0${subject}`;
  if (cachedPushConfiguration?.source === source) {
    return cachedPushConfiguration.status;
  }
  const configuration = { publicKey, privateKey, subject };
  const status = createVapidJwt({
    audience: "https://push.invalid",
    expiration: 60,
    ...configuration,
  }).then(() => ({
    configuration,
    error: null,
  })).catch((error: unknown) => {
    console.error("Invalid Web Push configuration", pushFailureDetails(error));
    return {
      configuration: null,
      error: "Web Push server configuration is invalid.",
    };
  });
  cachedPushConfiguration = { source, status };
  return status;
}

export const pushNotificationRoutes = new Hono<AppEnv>()
  .use("*", requireSessionAuth)
  .get("/config", async (c) => {
    const status = await pushConfiguration(c.env);
    return c.json({
      ok: true as const,
      enabled: Boolean(status.configuration),
      publicKey: status.configuration?.publicKey ?? null,
      error: status.error,
    });
  })
  .get("/preferences", async (c) => {
    const userId = c.get("user").id;
    const rows = await createDb(c.env.DB)
      .select({
        mailboxId: mailboxes.id,
        displayName: mailboxes.displayName,
        address: mailboxAddressSql,
        enabled: mailboxNotificationPreferences.enabled,
      })
      .from(mailboxMembers)
      .innerJoin(mailboxes, eq(mailboxMembers.mailboxId, mailboxes.id))
      .innerJoin(domains, eq(mailboxes.domainId, domains.id))
      .leftJoin(
        mailboxNotificationPreferences,
        and(
          eq(mailboxNotificationPreferences.mailboxId, mailboxMembers.mailboxId),
          eq(mailboxNotificationPreferences.userId, mailboxMembers.userId),
        ),
      )
      .where(eq(mailboxMembers.userId, userId))
      .orderBy(
        mailboxKindOrderSql,
        desc(mailboxes.isPrimary),
        mailboxes.displayName,
      );
    return c.json({
      ok: true as const,
      preferences: rows.map((row) => ({ ...row, enabled: row.enabled ?? true })),
    });
  })
  .put(
    "/preferences/:mailboxId",
    zValidator("json", notificationPreferenceSchema),
    async (c) => {
      const userId = c.get("user").id;
      const mailboxId = c.req.param("mailboxId");
      if (!await getMailboxAccess(createDb(c.env.DB), userId, mailboxId)) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const now = new Date();
      await createDb(c.env.DB)
        .insert(mailboxNotificationPreferences)
        .values({ mailboxId, userId, enabled: c.req.valid("json").enabled, updatedAt: now })
        .onConflictDoUpdate({
          target: [
            mailboxNotificationPreferences.mailboxId,
            mailboxNotificationPreferences.userId,
          ],
          set: { enabled: c.req.valid("json").enabled, updatedAt: now },
        });
      return c.json({ ok: true as const });
    },
  )
  .put(
    "/subscriptions",
    zValidator("json", pushSubscriptionSchema),
    async (c) => {
      const input = c.req.valid("json");
      const now = new Date();
      await createDb(c.env.DB)
        .insert(pushSubscriptions)
        .values({
          id: createId("push"),
          userId: c.get("user").id,
          endpoint: input.endpoint,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: {
            userId: c.get("user").id,
            p256dh: input.keys.p256dh,
            auth: input.keys.auth,
            updatedAt: now,
          },
        });
      return c.json({ ok: true as const });
    },
  )
  .delete(
    "/subscriptions",
    zValidator("json", subscriptionEndpointSchema),
    async (c) => {
      await createDb(c.env.DB)
        .delete(pushSubscriptions)
        .where(and(
          eq(pushSubscriptions.userId, c.get("user").id),
          eq(pushSubscriptions.endpoint, c.req.valid("json").endpoint),
        ));
      return c.json({ ok: true as const });
    },
  );

async function subscriptionsForMailbox(
  env: Env & PushBindings,
  mailboxId: string,
) {
  const db = createDb(env.DB);
  return db.select({
    id: pushSubscriptions.id,
  })
    .from(pushSubscriptions)
    .innerJoin(users, eq(pushSubscriptions.userId, users.id))
    .innerJoin(
      mailboxMembers,
      and(
        eq(mailboxMembers.userId, pushSubscriptions.userId),
        eq(mailboxMembers.mailboxId, mailboxId),
      ),
    )
    .leftJoin(
      mailboxNotificationPreferences,
      and(
        eq(mailboxNotificationPreferences.userId, pushSubscriptions.userId),
        eq(mailboxNotificationPreferences.mailboxId, mailboxId),
      ),
    )
    .where(and(
      eq(users.status, "active"),
      or(
        isNull(mailboxNotificationPreferences.enabled),
        eq(mailboxNotificationPreferences.enabled, true),
      ),
    ));
}

async function dispatchPushJob(
  env: Env & PushBindings,
  job: Extract<MailboxPushJob, { type: "dispatch" }>,
) {
  const db = createDb(env.DB);
  const [mailbox, subscriptions] = await Promise.all([
    db.select({ displayName: mailboxes.displayName })
      .from(mailboxes)
      .where(eq(mailboxes.id, job.mailboxId))
      .limit(1)
      .then((rows) => rows[0]),
    subscriptionsForMailbox(env, job.mailboxId),
  ]);
  if (!mailbox || !subscriptions.length) return;

  const requests: MessageSendRequest<MailboxPushJob>[] = subscriptions.map(
    (subscription) => ({
      body: {
        ...job,
        type: "deliver",
        targetSubscriptionId: subscription.id,
        mailboxDisplayName: mailbox.displayName,
      },
    }),
  );
  for (let index = 0; index < requests.length; index += MAX_QUEUE_SEND_BATCH_SIZE) {
    await env.PUSH_NOTIFICATIONS.sendBatch(
      requests.slice(index, index + MAX_QUEUE_SEND_BATCH_SIZE),
    );
  }
}

async function targetSubscription(
  env: Env & PushBindings,
  job: Extract<MailboxPushJob, { type: "deliver" }>,
) {
  return createDb(env.DB).select({
    id: pushSubscriptions.id,
    userId: pushSubscriptions.userId,
    endpoint: pushSubscriptions.endpoint,
    p256dh: pushSubscriptions.p256dh,
    auth: pushSubscriptions.auth,
  })
    .from(pushSubscriptions)
    .innerJoin(users, eq(pushSubscriptions.userId, users.id))
    .innerJoin(
      mailboxMembers,
      and(
        eq(mailboxMembers.userId, pushSubscriptions.userId),
        eq(mailboxMembers.mailboxId, job.mailboxId),
      ),
    )
    .leftJoin(
      mailboxNotificationPreferences,
      and(
        eq(mailboxNotificationPreferences.userId, pushSubscriptions.userId),
        eq(mailboxNotificationPreferences.mailboxId, job.mailboxId),
      ),
    )
    .where(and(
      eq(users.status, "active"),
      or(
        isNull(mailboxNotificationPreferences.enabled),
        eq(mailboxNotificationPreferences.enabled, true),
      ),
      eq(pushSubscriptions.id, job.targetSubscriptionId),
    ))
    .limit(1)
    .then((rows) => rows[0]);
}

async function removeSubscription(
  env: Env & PushBindings,
  subscriptionId: string,
) {
  try {
    await createDb(env.DB)
      .delete(pushSubscriptions)
      .where(eq(pushSubscriptions.id, subscriptionId));
  } catch (error) {
    console.error("Could not remove invalid push subscription", error);
  }
}

async function deliverPushJob(
  env: Env & PushBindings,
  job: Extract<MailboxPushJob, { type: "deliver" }>,
  configuration: PushConfiguration,
  ageMs: number,
) {
  const subscription = await targetSubscription(env, job);
  if (!subscription) return;
  const suppressed = await mailboxStub(env, job.mailboxId).shouldSuppressPush(
    job.messageId,
    subscription.userId,
  );
  if (suppressed) return;

  await sendToSubscription(
    env,
    subscription,
    {
      title: `New email in ${job.mailboxDisplayName}`,
      body: `${job.sender} · ${job.subject || "(no subject)"}`,
      url: `/mail/${encodeURIComponent(job.mailboxId)}?folder=inbox&conversation=${encodeURIComponent(job.conversationId)}`,
      tag: `message-${job.messageId}`,
    },
    `message:${job.messageId}`,
    configuration,
    ageMs,
  );
}

async function sendToSubscription(
  env: Env & PushBindings,
  subscription: { id: string; endpoint: string; p256dh: string; auth: string },
  payload: { title: string; body: string; url: string; tag: string },
  topic: string,
  configuration: PushConfiguration,
  ageMs: number,
) {
  try {
    const delivered = await sendPushNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      payload,
      configuration,
      {
        ttl: Math.max(1, Math.ceil((MAX_PUSH_JOB_AGE_MS - ageMs) / 1_000)),
        urgency: "high",
        topic: await topicFromString(topic),
      },
    );
    if (!delivered) await removeSubscription(env, subscription.id);
  } catch (error) {
    const delaySeconds = retryDelaySeconds(error);
    if (delaySeconds === null) {
      console.error(
        "Push notification delivery was rejected",
        pushFailureDetails(error),
      );
      return;
    }
    throw new RetryablePushError(delaySeconds, error);
  }
}

/**
 * Calendar reminders fan out to every device of the calendar's owner, one
 * queue message per device, like mail notifications.
 */
async function processCalendarReminder(
  env: Env & PushBindings,
  job: CalendarReminderPushJob,
  configuration: PushConfiguration,
  ageMs: number,
) {
  const subscriptions = await createDb(env.DB).select({
    id: pushSubscriptions.id,
    endpoint: pushSubscriptions.endpoint,
    p256dh: pushSubscriptions.p256dh,
    auth: pushSubscriptions.auth,
  })
    .from(pushSubscriptions)
    .innerJoin(users, eq(pushSubscriptions.userId, users.id))
    .where(and(
      eq(users.status, "active"),
      eq(pushSubscriptions.userId, job.userId),
      job.targetSubscriptionId
        ? eq(pushSubscriptions.id, job.targetSubscriptionId)
        : undefined,
    ));
  if (!job.targetSubscriptionId) {
    if (!subscriptions.length || !await calendarModuleEnabled(env.DB)) return;
    const requests = subscriptions.map((subscription) => ({
      body: { ...job, targetSubscriptionId: subscription.id },
    }));
    for (let index = 0; index < requests.length; index += MAX_QUEUE_SEND_BATCH_SIZE) {
      await env.PUSH_NOTIFICATIONS.sendBatch(
        requests.slice(index, index + MAX_QUEUE_SEND_BATCH_SIZE),
      );
    }
    return;
  }
  const subscription = subscriptions[0];
  if (!subscription) return;
  const tag = `calendar-${job.eventId}-${job.occurrenceStart}`;
  await sendToSubscription(
    env,
    subscription,
    { title: job.title, body: job.body, url: "/calendar", tag },
    tag,
    configuration,
    ageMs,
  );
}

async function processPushJob(
  env: Env & PushBindings,
  job: MailboxPushJob | CalendarReminderPushJob,
) {
  const ageMs = Math.max(0, Date.now() - job.occurredAt);
  if (ageMs >= MAX_PUSH_JOB_AGE_MS) return;
  const configuration = (await pushConfiguration(env)).configuration;
  if (!configuration) return;
  if (job.type === "calendar-reminder") {
    await processCalendarReminder(env, job, configuration, ageMs);
  } else if (job.type === "dispatch") await dispatchPushJob(env, job);
  else await deliverPushJob(env, job, configuration, ageMs);
}

export async function consumePushNotifications(
  batch: MessageBatch<unknown>,
  env: Env & PushBindings,
) {
  await Promise.all(batch.messages.map(async (message) => {
    const parsed = queuedPushJobSchema.safeParse(message.body);
    if (!parsed.success) {
      console.error("Ignoring invalid push notification job", parsed.error);
      message.ack();
      return;
    }
    try {
      await processPushJob(env, parsed.data);
      message.ack();
    } catch (error) {
      console.error(
        "Could not deliver push notification job",
        pushFailureDetails(
          error instanceof RetryablePushError ? error.cause : error,
        ),
      );
      message.retry({
        delaySeconds: error instanceof RetryablePushError
          ? error.delaySeconds
          : 30,
      });
    }
  }));
}
