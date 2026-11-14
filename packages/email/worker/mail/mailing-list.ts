import {
  createDb,
  mailboxAddressSql,
  mailboxAccess,
  mailboxes,
  teamMembership,
  users,
  emailDomain,
  normalizeEmail,
  normalizeMailboxAddress,
} from "@open-workspace/core/module";
import type { ListPostingPolicy } from "@open-workspace/core/shared";
import { and, eq, sql } from "drizzle-orm";

import { mailboxStub } from "../mailbox";
import { receiveArchived } from "./archive";
import { parseInboundAuthentication } from "./auth-headers";
import { rawHeaderText } from "./inbound";
import { inboundDeliveryId } from "./inbound-delivery";

export type MailingList = {
  id: string;
  teamId: string;
  listPosting: ListPostingPolicy;
};

/** The primary mailbox of each active member: where their copy lands. */
async function memberMailboxIds(db: D1Database, teamId: string) {
  const rows = await createDb(db)
    .selectDistinct({ id: mailboxes.id })
    .from(teamMembership)
    .innerJoin(
      users,
      and(eq(users.id, teamMembership.userId), eq(users.status, "active"))
    )
    .innerJoin(
      mailboxes,
      and(
        eq(mailboxes.ownerUserId, teamMembership.userId),
        eq(mailboxes.isPrimary, true)
      )
    )
    .where(eq(teamMembership.teamId, teamId));

  return rows.map((row) => row.id);
}

/**
 * The verified sender of a message, when its From domain passed DMARC at
 * Cloudflare. Anything else may be forged and grants no posting rights.
 */
async function verifiedSender(rawMime: ArrayBuffer) {
  let from: string | null = null;

  try {
    const { default: PostalMime } = await import("postal-mime");
    from =
      (await PostalMime.parse(rawHeaderText(rawMime))).from?.address ?? null;
  } catch {
    return null;
  }

  if (!from) return null;

  const authentication = parseInboundAuthentication({
    raw: rawHeaderText(rawMime),
    fromAddress: from,
  });

  const sender = normalizeEmail(from);

  return authentication.dmarc?.result === "pass" &&
    authentication.dmarc.headerFrom === emailDomain(sender)
    ? sender
    : null;
}

async function mayPost(
  db: D1Database,
  list: MailingList,
  rawMime: ArrayBuffer
) {
  if (list.listPosting === "anyone") return true;
  const sender = await verifiedSender(rawMime);

  if (!sender) return false;
  const orm = createDb(db);

  const [mailbox] = await orm
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(sql`${mailboxAddressSql} = ${sender}`)
    .limit(1);

  if (!mailbox) return false;

  if (list.listPosting === "workspace") return true;

  // Members post from any address they may send from.
  const [member] = await orm
    .select({ userId: mailboxAccess.userId })
    .from(mailboxAccess)
    .innerJoin(
      teamMembership,
      and(
        eq(teamMembership.userId, mailboxAccess.userId),
        eq(teamMembership.teamId, list.teamId)
      )
    )
    .where(
      and(
        eq(mailboxAccess.mailboxId, mailbox.id),
        eq(mailboxAccess.canSend, true)
      )
    )
    .limit(1);

  return Boolean(member);
}

/**
 * Copies mail sent to a team's mailing list into each member's own mailbox.
 * The copies share one stored original and never leave the workspace.
 */
export async function deliverToList(input: {
  env: Env;
  list: MailingList;
  message: { from: string; to: string; setReject(reason: string): void };
  raw: ArrayBuffer;
  receivedAt: number;
}) {
  const { env, list, message, raw } = input;

  if (!(await mayPost(env.DB, list, raw))) {
    message.setReject(
      `You are not allowed to post to ${normalizeMailboxAddress(message.to)}`
    );

    return;
  }

  const recipients = await memberMailboxIds(env.DB, list.teamId);

  if (!recipients.length) return;
  const listAddress = normalizeMailboxAddress(message.to);

  const deliveryId = await inboundDeliveryId({
    mailboxId: list.id,
    envelopeFrom: message.from,
    envelopeTo: message.to,
    raw,
  });

  const objectKey = `lists/${list.id}/raw/${deliveryId}.eml`;

  // Archived once, as the list's: the members' copies share this original.
  await receiveArchived(
    env,
    {
      id: deliveryId,
      mailboxId: list.id,
      sourceKey: objectKey,
      receivedAt: input.receivedAt,
    },
    raw,
    async () => {
      await Promise.all(
        recipients.map(async (mailboxId) =>
          mailboxStub(env, mailboxId).enqueueInbound({
            id: await inboundDeliveryId({
              mailboxId,
              envelopeFrom: message.from,
              envelopeTo: message.to,
              raw,
            }),
            mailboxId,
            rawObjectKey: objectKey,
            envelopeFrom: message.from,
            envelopeTo: message.to,
            listAddress,
            receivedAt: input.receivedAt,
          })
        )
      );
      await env.MAIL_STORAGE.put(objectKey, raw, {
        httpMetadata: { contentType: "message/rfc822" },
      });
    }
  );
}
