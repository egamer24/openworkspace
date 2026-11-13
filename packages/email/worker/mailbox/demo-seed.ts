import {
  demoMailboxConversationState,
  demoMailboxEmails,
  demoMailboxObjects,
  demoMailboxFolders,
  demoMailboxEmailIds,
  demoMailboxSenders,
} from "./demo";
import { mailboxStub } from "./index";

async function seedDemoMailbox(env: Env, mailboxId: string) {
  const mailbox = mailboxStub(env, mailboxId);
  const senders = demoMailboxSenders(mailboxId);
  await mailbox.seedMailbox(
    demoMailboxFolders(mailboxId),
    demoMailboxEmails(mailboxId),
    demoMailboxConversationState(mailboxId),
    senders
  );
  await mailbox.resetDemoSafetyState({
    emailIds: demoMailboxEmailIds(mailboxId),
    blockedPatterns: senders.flatMap((sender) =>
      "blockedAt" in sender && sender.blockedAt
        ? [{ pattern: sender.address, at: sender.blockedAt.getTime() }]
        : []
    ),
  });
}

/** Seeds the demo administrator's mailboxes. */
export async function seedEmailDemo(env: Env) {
  await Promise.all(
    // Rows only reference the R2 keys, so objects and rows seed concurrently.
    ["mbx_demo_personal", "mbx_demo_support"].flatMap((mailboxId) => [
      ...demoMailboxObjects(mailboxId).map((object) =>
        env.MAIL_STORAGE.put(object.key, object.body, {
          httpMetadata: { contentType: object.contentType },
          customMetadata:
            "customMetadata" in object ? object.customMetadata : undefined,
        })
      ),
      seedDemoMailbox(env, mailboxId),
    ])
  );
}
