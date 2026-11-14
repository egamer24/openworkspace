import { mailboxStub } from "../mailbox";
import { archiveMailboxNow } from "./archive";

/**
 * Deletes the mailbox's objects a page at a time, except raw copies the
 * mail archive doesn't have yet (`keep`): those stay in the bucket.
 */
async function deleteMailboxObjects(
  bucket: R2Bucket,
  mailboxId: string,
  keep: Set<string>
) {
  const prefix = `mailboxes/${mailboxId}/`;
  let cursor: string | undefined;

  do {
    // oxlint-disable-next-line eslint/no-await-in-loop -- R2 lists one page at a time
    const page = await bucket.list({ prefix, limit: 1000, cursor });

    const keys = page.objects
      .map((object) => object.key)
      .filter((key) => !keep.has(key));

    // oxlint-disable-next-line eslint/no-await-in-loop -- see above
    if (keys.length) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function deleteMailboxStorage(env: Env, mailboxId: string) {
  // Archive what's still open first, so its raw copies can go too.
  // ponytail: a copy that still fails stays in the mail bucket after it is archived; clean such leftovers up in runArchiveTick if they ever add up.
  const keep = await archiveMailboxNow(env, mailboxId);

  await Promise.all([
    mailboxStub(env, mailboxId).deleteMailboxData(),
    deleteMailboxObjects(env.MAIL_STORAGE, mailboxId, keep),
  ]);
}
