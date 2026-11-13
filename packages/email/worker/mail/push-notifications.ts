import {
  sendPushNotification,
  topicFromString,
  WebPushError,
} from "@mmmike/web-push/send";
import { createVapidJwt, urlBase64ToUint8Array } from "@mmmike/web-push/vapid";
import {
  zValidator,
  requireSessionAuth,
  createDb,
  mailboxAccess,
  mailboxes,
  users,
  mailboxAddressSql,
  mailboxKindOrderSql,
  apiError,
  createId,
} from "@open-workspace/core/module";
import type {
  BatchStatement,
  Database,
  AppEnv,
} from "@open-workspace/core/module";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { MailboxPushJob } from "../../shared/mail";
import { mailPath } from "../../shared/mail-path";
import {
  mailboxNotificationPreferences,
  pushSubscriptions,
} from "../db/schema";
import { deliverJmapStateChange } from "../jmap/push";
import { mailboxStub } from "../mailbox";
import { getMailboxAccess } from "./access";
import { assertProxyableRemoteUrl } from "./remote-proxy";

/**
 * Push goes to whatever push service the subscriber's browser uses, so any
 * public HTTPS host is accepted (a self-hosted Mozilla autopush included).
 * What is refused is what the image proxy refuses: credentials in the URL,
 * localhost, private and internal addresses, and internal-only names.
 */
function isPublicPushEndpoint(endpoint: string) {
  try {
    return assertProxyableRemoteUrl(endpoint).protocol === "https:";
  } catch {
    return false;
  }
}

const pushSubscriptionSchema = z.object({
  // The Worker POSTs to the endpoint for every new message, so it must be a
  // public HTTPS URL (isPublicPushEndpoint), never a relay into the network.
  endpoint: z
    .url()
    .max(4096)
    .refine(isPublicPushEndpoint, "Push endpoint must be a public HTTPS URL"),
  keys: z.object({
    p256dh: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => {
        try {
          const key = urlBase64ToUint8Array(value);

          return key.length === 65 && key[0] === 4;
        } catch {
          return false;
        }
      }, "p256dh must be an uncompressed P-256 public key"),
    auth: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => {
        try {
          return urlBase64ToUint8Array(value).length >= 16;
        } catch {
          return false;
        }
      }, "auth must contain at least 16 bytes"),
  }),
});

const subscriptionEndpointSchema = z.object({
  endpoint: z.string().url().max(4096),
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
  z.object({
    type: z.literal("jmap-state"),
    mailboxId: z.string().min(1),
    state: z.string().min(1).max(100),
    occurredAt: z.number().int().nonnegative(),
  }),
  pushJobBaseSchema.extend({ type: z.literal("dispatch") }),
  pushJobBaseSchema.extend({
    type: z.literal("deliver"),
    targetSubscriptionId: z.string().min(1),
    mailboxDisplayName: z.string().min(1).max(500),
  }),
]) satisfies z.ZodType<MailboxPushJob>;

const MAX_PUSH_JOB_AGE_MS = 15 * 60 * 1000;
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
    cause: unknown
  ) {
    super("Push delivery should be retried", { cause });
  }
}

function retryDelaySeconds(cause: unknown) {
  if (
    cause instanceof WebPushError &&
    cause.statusCode !== 408 &&
    cause.statusCode !== 429 &&
    cause.statusCode < 500
  ) {
    return null;
  }

  const timedOut =
    cause instanceof DOMException &&
    (cause.name === "AbortError" || cause.name === "TimeoutError");

  if (
    !(cause instanceof WebPushError) &&
    !(cause instanceof TypeError) &&
    !timedOut
  ) {
    return null;
  }

  const delayMs =
    cause instanceof WebPushError ? (cause.retryAfterMs ?? 30_000) : 30_000;

  return Math.max(1, Math.min(12 * 60 * 60, Math.ceil(delayMs / 1000)));
}

function pushFailureDetails(cause: unknown) {
  if (cause instanceof WebPushError) {
    return {
      name: cause.name,
      message: cause.message,
      statusCode: cause.statusCode,
      retryAfterMs: cause.retryAfterMs,
    };
  }

  return cause instanceof Error
    ? { name: cause.name, message: cause.message }
    : { message: String(cause) };
}

/** The Web Push settings, as push code reads them. */
export type PushBindings = Pick<
  Env,
  "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "VAPID_SUBJECT"
>;

function pushConfiguration(
  env: PushBindings & { IDENTITY_PROVIDER_ORIGIN: string }
) {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  // Push services want a contact; the app's own URL is one.
  const subject = env.VAPID_SUBJECT ?? env.IDENTITY_PROVIDER_ORIGIN;

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
  })
    .then(() => ({
      configuration,
      error: null,
    }))
    .catch((cause: unknown) => {
      console.error(
        "Invalid Web Push configuration",
        pushFailureDetails(cause)
      );

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
      .from(mailboxAccess)
      .innerJoin(mailboxes, eq(mailboxAccess.mailboxId, mailboxes.id))
      .leftJoin(
        mailboxNotificationPreferences,
        and(
          eq(mailboxNotificationPreferences.mailboxId, mailboxAccess.mailboxId),
          eq(mailboxNotificationPreferences.userId, mailboxAccess.userId)
        )
      )
      .where(eq(mailboxAccess.userId, userId))
      .orderBy(
        mailboxKindOrderSql,
        desc(mailboxes.isPrimary),
        mailboxes.displayName
      );

    return c.json({
      ok: true as const,
      preferences: rows.map((row) => ({
        ...row,
        enabled: row.enabled ?? true,
      })),
    });
  })
  .put(
    "/preferences/:mailboxId",
    zValidator("json", notificationPreferenceSchema),
    async (c) => {
      const userId = c.get("user").id;
      const mailboxId = c.req.param("mailboxId");

      if (!(await getMailboxAccess(createDb(c.env.DB), userId, mailboxId))) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }

      const now = new Date();
      await createDb(c.env.DB)
        .insert(mailboxNotificationPreferences)
        .values({
          mailboxId,
          userId,
          enabled: c.req.valid("json").enabled,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            mailboxNotificationPreferences.mailboxId,
            mailboxNotificationPreferences.userId,
          ],
          set: { enabled: c.req.valid("json").enabled, updatedAt: now },
        });

      return c.json({ ok: true as const });
    }
  )
  .put(
    "/subscriptions",
    zValidator("json", pushSubscriptionSchema),
    async (c) => {
      const input = c.req.valid("json");
      const now = new Date();
      // Bound to this session, so revoking or signing out of it ends the
      // device's notifications. The app registers again on every start, so
      // after a new sign-in on the device the row follows the new session.
      const sessionId = c.get("sessionId");
      await createDb(c.env.DB)
        .insert(pushSubscriptions)
        .values({
          id: createId("push"),
          userId: c.get("user").id,
          sessionId,
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
            sessionId,
            p256dh: input.keys.p256dh,
            auth: input.keys.auth,
            updatedAt: now,
          },
        });

      return c.json({ ok: true as const });
    }
  )
  .delete(
    "/subscriptions",
    zValidator("json", subscriptionEndpointSchema),
    async (c) => {
      await createDb(c.env.DB)
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.userId, c.get("user").id),
            eq(pushSubscriptions.endpoint, c.req.valid("json").endpoint)
          )
        );

      return c.json({ ok: true as const });
    }
  );

/**
 * One session was revoked or signed out: its device stops getting
 * notifications, in the batch that deletes the session. Rows without a
 * session (registered before they were recorded) stay until the device
 * registers again or every session goes.
 */
export function deleteSessionPushSubscriptions(
  db: Database,
  session: { userId: string; sessionId: string }
): BatchStatement[] {
  return [
    db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, session.userId),
          eq(pushSubscriptions.sessionId, session.sessionId)
        )
      ),
  ];
}

/** A person's sessions were all revoked: no device of theirs gets notifications. */
export function deleteUserPushSubscriptions(
  db: Database,
  userId: string
): BatchStatement[] {
  return [
    db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)),
  ];
}

function subscriptionsForMailbox(env: Env, mailboxId: string) {
  const db = createDb(env.DB);

  return db
    .select({
      id: pushSubscriptions.id,
    })
    .from(pushSubscriptions)
    .innerJoin(users, eq(pushSubscriptions.userId, users.id))
    .innerJoin(
      mailboxAccess,
      and(
        eq(mailboxAccess.userId, pushSubscriptions.userId),
        eq(mailboxAccess.mailboxId, mailboxId)
      )
    )
    .leftJoin(
      mailboxNotificationPreferences,
      and(
        eq(mailboxNotificationPreferences.userId, pushSubscriptions.userId),
        eq(mailboxNotificationPreferences.mailboxId, mailboxId)
      )
    )
    .where(
      and(
        eq(users.status, "active"),
        or(
          isNull(mailboxNotificationPreferences.enabled),
          eq(mailboxNotificationPreferences.enabled, true)
        )
      )
    );
}

async function dispatchPushJob(
  env: Env,
  job: Extract<MailboxPushJob, { type: "dispatch" }>
) {
  const db = createDb(env.DB);

  const [mailbox, subscriptions] = await Promise.all([
    db
      .select({ displayName: mailboxes.displayName })
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
    })
  );

  const batches: MessageSendRequest<MailboxPushJob>[][] = [];

  for (
    let index = 0;
    index < requests.length;
    index += MAX_QUEUE_SEND_BATCH_SIZE
  ) {
    batches.push(requests.slice(index, index + MAX_QUEUE_SEND_BATCH_SIZE));
  }

  // Each subscription's delivery is its own job, so the batches are independent.
  await Promise.all(
    batches.map((batch) => env.PUSH_NOTIFICATIONS.sendBatch(batch))
  );
}

function targetSubscription(
  env: Env,
  job: Extract<MailboxPushJob, { type: "deliver" }>
) {
  return createDb(env.DB)
    .select({
      id: pushSubscriptions.id,
      userId: pushSubscriptions.userId,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
    })
    .from(pushSubscriptions)
    .innerJoin(users, eq(pushSubscriptions.userId, users.id))
    .innerJoin(
      mailboxAccess,
      and(
        eq(mailboxAccess.userId, pushSubscriptions.userId),
        eq(mailboxAccess.mailboxId, job.mailboxId)
      )
    )
    .leftJoin(
      mailboxNotificationPreferences,
      and(
        eq(mailboxNotificationPreferences.userId, pushSubscriptions.userId),
        eq(mailboxNotificationPreferences.mailboxId, job.mailboxId)
      )
    )
    .where(
      and(
        eq(users.status, "active"),
        or(
          isNull(mailboxNotificationPreferences.enabled),
          eq(mailboxNotificationPreferences.enabled, true)
        ),
        eq(pushSubscriptions.id, job.targetSubscriptionId)
      )
    )
    .limit(1)
    .then((rows) => rows[0]);
}

async function removeSubscription(env: Env, subscriptionId: string) {
  try {
    await createDb(env.DB)
      .delete(pushSubscriptions)
      .where(eq(pushSubscriptions.id, subscriptionId));
  } catch (error) {
    console.error("Could not remove invalid push subscription", error);
  }
}

async function deliverPushJob(
  env: Env,
  job: Extract<MailboxPushJob, { type: "deliver" }>,
  configuration: PushConfiguration,
  ageMs: number
) {
  const subscription = await targetSubscription(env, job);

  if (!subscription) return;

  // Registered before endpoints had to be public HTTPS URLs.
  if (!isPublicPushEndpoint(subscription.endpoint)) {
    await removeSubscription(env, subscription.id);

    return;
  }

  const suppressed = await mailboxStub(env, job.mailboxId).shouldSuppressPush(
    job.messageId,
    subscription.userId
  );

  if (suppressed) return;

  try {
    const delivered = await sendPushNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      {
        title: `New email in ${job.mailboxDisplayName}`,
        body: `${job.sender} · ${job.subject || "(no subject)"}`,
        url: mailPath(job.mailboxId, "inbox", job.conversationId),
        tag: `message-${job.messageId}`,
      },
      configuration,
      {
        ttl: Math.max(1, Math.ceil((MAX_PUSH_JOB_AGE_MS - ageMs) / 1000)),
        urgency: "high",
        topic: await topicFromString(`message:${job.messageId}`),
      }
    );

    if (!delivered) await removeSubscription(env, subscription.id);
  } catch (error) {
    const delaySeconds = retryDelaySeconds(error);

    if (delaySeconds === null) {
      console.error(
        "Push notification delivery was rejected",
        pushFailureDetails(error)
      );

      return;
    }

    throw new RetryablePushError(delaySeconds, error);
  }
}

/** The server's VAPID identity, or null when push is not configured. */
export async function vapidConfiguration(env: Env) {
  return (await pushConfiguration(env)).configuration;
}

async function processPushJob(env: Env, job: MailboxPushJob) {
  const ageMs = Math.max(0, Date.now() - job.occurredAt);

  if (ageMs >= MAX_PUSH_JOB_AGE_MS) return;
  const { configuration } = await pushConfiguration(env);

  if (!configuration) return;

  if (job.type === "jmap-state") {
    await deliverJmapStateChange(env, job, configuration);
  } else if (job.type === "dispatch") await dispatchPushJob(env, job);
  else await deliverPushJob(env, job, configuration, ageMs);
}

export async function consumePushNotifications(
  batch: MessageBatch<unknown>,
  env: Env
) {
  await Promise.all(
    batch.messages.map(async (message) => {
      const parsed = pushJobSchema.safeParse(message.body);

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
            error instanceof RetryablePushError ? error.cause : error
          )
        );
        message.retry({
          delaySeconds:
            error instanceof RetryablePushError ? error.delaySeconds : 30,
        });
      }
    })
  );
}
