import { and, eq, sql } from "drizzle-orm";

import { mailboxAddressParts } from "../lib/ids";
import { mailboxes } from "./schema";

export const mailboxAddressSql = sql<string>`${mailboxes.localPart} || '@' || ${mailboxes.domain}`;

// Personal mailboxes sort before shared mailboxes without persisting a
// duplicated kind column. Primary ordering is applied separately by callers.
export const mailboxKindOrderSql = sql<number>`${mailboxes.ownerUserId} IS NULL`;

export function mailboxAddress(localPart: string, domain: string) {
  return `${localPart}@${domain}`;
}

export function mailboxKind(ownerUserId: string | null) {
  return ownerUserId ? ("personal" as const) : ("shared" as const);
}

/** The mailbox with this address, which may be on any domain, configured or not. */
export function mailboxAddressPredicate(address: string) {
  const parts = mailboxAddressParts(address);

  return and(
    eq(mailboxes.domain, parts.domain),
    eq(mailboxes.localPart, parts.localPart)
  );
}
