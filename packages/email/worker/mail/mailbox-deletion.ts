import { mailboxStub } from "../mailbox";
import { repeatUntil } from "./repeat";
import { deleteRichImages } from "./rich-content";
import { signatureImagePrefix } from "./signatures";

/** Deletes the mailbox's objects a page at a time, until a listing comes back empty. */
async function deleteMailboxObjects(bucket: R2Bucket, mailboxId: string) {
  const prefix = `mailboxes/${mailboxId}/`;

  await repeatUntil(Number.POSITIVE_INFINITY, async () => {
    const page = await bucket.list({ prefix, limit: 1000 });
    const keys = page.objects.map((object) => object.key);

    if (!keys.length) return true;
    await bucket.delete(keys);

    return undefined;
  });
}

export async function deleteMailboxStorage(env: Env, mailboxId: string) {
  await Promise.all([
    mailboxStub(env, mailboxId).deleteMailboxData(),
    deleteMailboxObjects(env.MAIL_STORAGE, mailboxId),
    // The signature's row goes with the mailbox's (foreign key); its images here.
    deleteRichImages(env.MAIL_STORAGE, signatureImagePrefix(mailboxId)),
  ]);
}
