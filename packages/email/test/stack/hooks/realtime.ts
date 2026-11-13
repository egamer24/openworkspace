import { required } from "@open-workspace/core/shared";
import type { TestHook } from "@open-workspace/core/testing/worker";
import type { MailboxPushJob } from "@open-workspace/email/shared/mail.ts";
import { deliverJmapStateChange } from "@open-workspace/email/worker/jmap/push.ts";
import {
  listActiveMailboxSessions,
  listMailboxUsersByIds,
} from "@open-workspace/email/worker/mail/mailbox-directory.ts";
import { consumePushNotifications } from "@open-workspace/email/worker/mail/push-notifications.ts";
import type { PushBindings } from "@open-workspace/email/worker/mail/push-notifications.ts";

import { emailQueueRoles } from "../../../shared/module.ts";
import { fakeQueue, messageBatch, queueMessage, queueName } from "./fakes.ts";

/**
 * Test hooks for the JMAP, realtime, and push stack tests
 * (jmap, push-notifications, mailbox-directory).
 */
export const hooks = {
  "realtime.listActiveMailboxSessions": (
    { env },
    mailboxId: string,
    sessionIds: string[],
    now: number
  ) => listActiveMailboxSessions(env.DB, mailboxId, sessionIds, now),

  "realtime.listMailboxUsersByIds": (
    { env },
    mailboxId: string,
    userIds: string[]
  ) => listMailboxUsersByIds(env.DB, mailboxId, userIds),

  /** A JMAP state change pushed with the Worker's VAPID keys. */
  "realtime.deliverJmapStateChange": (
    { env },
    job: { mailboxId: string; state: string }
  ) =>
    deliverJmapStateChange(env, job, {
      publicKey: required(env.VAPID_PUBLIC_KEY, "the stack binds VAPID keys"),
      privateKey: required(env.VAPID_PRIVATE_KEY, "the stack binds VAPID keys"),
      subject: required(
        env.VAPID_SUBJECT,
        "the test stack sets a push contact"
      ),
    }),

  /**
   * Runs the push consumer on one job with the push queue's producer
   * replaced by a recorder, and optionally other VAPID settings or a fetch
   * that fails locally (as the pool's `vi.stubGlobal("fetch", ...)` did).
   * Returns the message's outcome and what the consumer queued.
   */
  "realtime.consumePushJob": async (
    { env },
    body: MailboxPushJob,
    options: { vapid?: PushBindings; failFetch?: string } = {}
  ) => {
    const outcome = { ack: 0, retry: 0 };
    const sent: MessageSendRequest<MailboxPushJob>[][] = [];

    const batch = messageBatch(
      queueName(env, emailQueueRoles.pushNotifications),
      [
        queueMessage(body, 1, {
          ack: () => void (outcome.ack += 1),
          retry: () => void (outcome.retry += 1),
        }),
      ]
    );

    const bindings: Env = {
      ...env,
      PUSH_NOTIFICATIONS: fakeQueue<MailboxPushJob>((messages) =>
        sent.push(messages)
      ),
      VAPID_PUBLIC_KEY: options.vapid?.VAPID_PUBLIC_KEY ?? env.VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY:
        options.vapid?.VAPID_PRIVATE_KEY ?? env.VAPID_PRIVATE_KEY,
      VAPID_SUBJECT: options.vapid?.VAPID_SUBJECT ?? env.VAPID_SUBJECT,
    };

    const fetchBefore = globalThis.fetch;

    const { failFetch } = options;

    if (failFetch) {
      globalThis.fetch = Object.assign(
        () => Promise.reject(new Error(failFetch)),
        { preconnect: fetchBefore.preconnect }
      );
    }

    try {
      await consumePushNotifications(batch, bindings);
    } finally {
      globalThis.fetch = fetchBefore;
    }

    return { ...outcome, sent };
  },
} satisfies Record<string, TestHook>;
