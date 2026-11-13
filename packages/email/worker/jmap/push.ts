import {
  rawPayload,
  sendPushNotification,
  topicFromString,
} from "@mmmike/web-push/send";
import {
  createDb,
  mailboxAccess,
  mailboxes,
  createId,
} from "@open-workspace/core/module";
import { and, eq, gt, inArray, isNotNull, lte } from "drizzle-orm";

import { jmapPushSubscriptions } from "../db/schema";
import { wantsMailChanges } from "./push-types";
import type { StateChange } from "./push-types";

export { JMAP_PUSH_TYPES } from "./push-types";

/** Subscriptions live a week unless the client asks for less, then renew. */
const MAX_SUBSCRIPTION_MS = 7 * 24 * 60 * 60 * 1000;

/** State changes are worth little once a client resyncs anyway. */
const STATE_CHANGE_TTL_SECONDS = 24 * 60 * 60;

export type PushVapid = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

type Subscription = typeof jmapPushSubscriptions.$inferSelect;

/** RFC 8620 §7.2.2: proves the client can read what is pushed to the URL. */
type PushVerification = {
  "@type": "PushVerification";
  pushSubscriptionId: string;
  verificationCode: string;
};

export function stateChange(changed: Record<string, string>): StateChange {
  return {
    "@type": "StateChange",
    changed: Object.fromEntries(
      Object.entries(changed).map(([accountId, state]) => [
        accountId,
        {
          Email: state,
          Mailbox: state,
          Thread: state,
          EmailDelivery: state,
        },
      ])
    ),
  };
}

/** When a subscription expires: as asked (a UTCDate), but within a week. */
export function subscriptionExpiry(
  requested: string | null | undefined,
  now = Date.now()
) {
  const latest = now + MAX_SUBSCRIPTION_MS;
  const asked = requested ? Date.parse(requested) : Number.NaN;

  return new Date(
    Number.isFinite(asked) ? Math.max(now, Math.min(asked, latest)) : latest
  );
}

/**
 * POSTs a JMAP push object to a subscription: Web Push encrypted (RFC 8291)
 * and VAPID-signed when the client gave keys, plain JSON otherwise.
 * Returns false when the push service says the subscription is gone.
 */
export async function postToSubscription(
  subscription: Pick<Subscription, "url" | "p256dh" | "auth">,
  body: StateChange | PushVerification,
  vapid: PushVapid | null,
  options: { ttl: number; topic?: string }
) {
  if (subscription.p256dh && subscription.auth) {
    if (!vapid) throw new Error("Web Push is not configured");

    return sendPushNotification(
      {
        endpoint: subscription.url,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      rawPayload(JSON.stringify(body)),
      vapid,
      // An undefined topic sends no Topic header.
      { ttl: options.ttl, urgency: "normal", topic: options.topic }
    );
  }

  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    ttl: String(options.ttl),
  });

  if (options.topic) headers.set("topic", options.topic);

  const response = await fetch(subscription.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (response.status === 404 || response.status === 410) return false;

  if (!response.ok) {
    throw new Error(`Push endpoint answered ${response.status}`);
  }

  return true;
}

export function newVerificationCode() {
  return createId("pvc");
}

/** Sends the PushVerification object a new subscription is confirmed with. */
export async function sendVerification(
  subscription: Subscription,
  vapid: PushVapid | null
) {
  await postToSubscription(
    subscription,
    {
      "@type": "PushVerification",
      pushSubscriptionId: subscription.id,
      verificationCode: subscription.verificationCode,
    },
    vapid,
    { ttl: 60 * 60 }
  );
}

/**
 * Tells every verified subscription of someone who can open the mailbox that
 * its state moved. Expired subscriptions are dropped on the way.
 */
export async function deliverJmapStateChange(
  env: Env,
  input: { mailboxId: string; state: string },
  vapid: PushVapid
) {
  const db = createDb(env.DB);
  const now = new Date();
  await db
    .delete(jmapPushSubscriptions)
    .where(lte(jmapPushSubscriptions.expiresAt, now));

  const targets = await db
    .select({ subscription: jmapPushSubscriptions })
    .from(jmapPushSubscriptions)
    .innerJoin(
      mailboxAccess,
      eq(mailboxAccess.userId, jmapPushSubscriptions.userId)
    )
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxAccess.mailboxId))
    .where(
      and(
        eq(mailboxAccess.mailboxId, input.mailboxId),
        eq(mailboxes.delivery, "inbox"),
        isNotNull(jmapPushSubscriptions.verifiedAt),
        gt(jmapPushSubscriptions.expiresAt, now)
      )
    );

  const gone: string[] = [];
  await Promise.all(
    targets.map(async ({ subscription }) => {
      if (!wantsMailChanges(subscription.typesJson)) return;

      try {
        const delivered = await postToSubscription(
          subscription,
          stateChange({ [input.mailboxId]: input.state }),
          vapid,
          {
            ttl: STATE_CHANGE_TTL_SECONDS,
            // A newer state replaces an undelivered older one.
            topic: await topicFromString(
              `jmap:${subscription.id}:${input.mailboxId}`
            ),
          }
        );

        if (!delivered) gone.push(subscription.id);
      } catch (error) {
        console.error(
          "JMAP push delivery failed",
          error instanceof Error ? error.message : String(error)
        );
      }
    })
  );

  if (gone.length) {
    await db
      .delete(jmapPushSubscriptions)
      .where(inArray(jmapPushSubscriptions.id, gone));
  }
}
