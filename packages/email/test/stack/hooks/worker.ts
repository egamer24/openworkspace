import type { TestHook } from "@open-workspace/core/testing/worker";
import { prepareOutboundDelivery } from "@open-workspace/email/worker/mail/outbound-delivery.ts";
import { signRemoteToken } from "@open-workspace/email/worker/mail/remote-token.ts";
import { discardComposerUploads } from "@open-workspace/email/worker/mail/uploads.ts";
import { mailboxStub } from "@open-workspace/email/worker/mailbox/index.ts";

/** Test hooks for the stack tests of this area (see index.ts): worker.test.ts, remote-content.test.ts. */
export const hooks = {
  /** The HTML a stored outgoing message is delivered with, as the sender builds it. */
  "worker.outboundDeliveryHtml": async (
    { env },
    mailboxId: string,
    messageId: string
  ) => {
    const email = await mailboxStub(env, mailboxId).getEmail(messageId);

    if (!email) throw new Error(`No message ${messageId} in ${mailboxId}`);
    const delivery = await prepareOutboundDelivery(env, email);

    return delivery.html;
  },
  /** A remote image token as the Worker would have issued it for `url` at `now`. */
  "worker.remoteToken": (
    { env },
    userId: string,
    mailboxId: string,
    url: string,
    now: number
  ) => signRemoteToken(env.MAIL_REMOTE_KEY, userId, mailboxId, url, now),
  /** Discards composer uploads that were never sent. */
  "worker.discardComposerUploads": async (
    { env },
    input: { mailboxId: string; userId: string; uploadIds: string[] }
  ) => {
    await discardComposerUploads({ env, ...input });
  },
} satisfies Record<string, TestHook>;
