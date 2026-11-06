import { mailboxAddressParts, normalizeMailboxAddress } from "../lib/ids";

export const FORWARDED_HEADER = "X-OpenWorkspace-Forwarded";
export const MAX_FORWARD_HOPS = 3;

export type InboundRoute = {
  /** Mailbox that stores the message, or null for a forward-only address. */
  mailboxId: string | null;
  keepCopy: boolean;
  /** Verified destination addresses to forward to unchanged. */
  forwards: string[];
};

/**
 * Resolves mailbox, alias, forward-only address and catch-all for one
 * recipient in a single D1 query, because it runs on every delivery.
 * Returns null when the recipient should be rejected.
 */
export async function resolveInboundRoute(
  db: D1Database,
  recipient: string,
): Promise<InboundRoute | null> {
  const { localPart, domain } = mailboxAddressParts(recipient);
  const row = await db.prepare(`
    SELECT
      coalesce(m.id, r.mailbox_id,
        CASE WHEN r.id IS NULL THEN d.unknown_recipient_mailbox_id END) AS mailboxId,
      r.id AS routeId,
      coalesce(r.keep_copy, 1) AS keepCopy,
      -- A throwaway stops working when it is turned off or its creator loses
      -- send access to the mailbox it delivers into.
      CASE WHEN r.disabled_at IS NOT NULL THEN 1
        WHEN r.throwaway = 1 AND NOT EXISTS (
          SELECT 1 FROM mailbox_members mm
          WHERE mm.mailbox_id = r.mailbox_id
            AND mm.user_id = r.created_by_user_id AND mm.can_send = 1
        ) THEN 1 ELSE 0 END AS disabled,
      (SELECT json_group_array(f.email)
        FROM routing_address_destinations rd
        JOIN forwarding_destinations f ON f.id = rd.destination_id
        WHERE rd.address_id = r.id AND f.verified_at IS NOT NULL) AS forwards
    FROM domains d
    LEFT JOIN mailboxes m ON m.domain_id = d.id AND m.local_part = ?1
    LEFT JOIN routing_addresses r ON r.domain_id = d.id AND r.local_part = ?1
    WHERE d.name = ?2
    LIMIT 1
  `).bind(localPart, domain).first<{
    mailboxId: string | null;
    routeId: string | null;
    keepCopy: number;
    disabled: number;
    forwards: string;
  }>();
  if (!row || (!row.mailboxId && !row.routeId) || row.disabled) return null;
  return {
    mailboxId: row.mailboxId,
    keepCopy: Boolean(row.keepCopy),
    forwards: JSON.parse(row.forwards) as string[],
  };
}

/**
 * Forwards the original message unchanged through Email Routing. Skips the
 * sender's own address and messages that already passed MAX_FORWARD_HOPS
 * OpenWorkspace forwards, so two forwarding deployments cannot loop forever.
 */
export async function forwardInbound(
  message: ForwardableEmailMessage,
  destinations: string[],
) {
  const hops = Number.parseInt(message.headers.get(FORWARDED_HEADER) ?? "0", 10) || 0;
  const sender = normalizeMailboxAddress(message.from);
  const targets = hops >= MAX_FORWARD_HOPS
    ? []
    : destinations.filter((destination) =>
      normalizeMailboxAddress(destination) !== sender);
  const results = await Promise.allSettled(targets.map((destination) =>
    message.forward(
      destination,
      new Headers({ [FORWARDED_HEADER]: String(hops + 1) }),
    )));
  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("Email Routing forward failed", result.reason);
    }
  }
  return {
    forwarded: results.filter((result) => result.status === "fulfilled").length,
    failed: results.filter((result) => result.status === "rejected").length,
  };
}
