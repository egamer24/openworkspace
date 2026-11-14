import {
  createDb,
  mailboxes,
  normalizeMailboxAddress,
} from "@open-workspace/core/module";
import type { MailboxDelivery } from "@open-workspace/core/shared";
import { and, eq, inArray, or } from "drizzle-orm";

import { headerValues } from "../../shared/mail-headers";
import { workspaceBlockFor } from "../mailbox/senders";
import { parseInboundAuthentication } from "./auth-headers";
import { destinationStatuses } from "./email-routing";
import { rawHeaderText } from "./inbound";
import { workspaceBlockPatterns } from "./workspace-safety";

// Same header and limit as mailbox rules, so either kind of forward counts
// the other's hops.
export const MAX_FORWARD_HOPS = 3;

export const FORWARD_HOP_HEADER = "X-OpenWorkspace-Forwarded";

/**
 * How many times this install already forwarded a message: the largest
 * digits-only hop header. Other values ("-1000000") are ignored, never
 * parsed, so a sender can't lift the limit.
 */
export function forwardHops(raw: ArrayBuffer) {
  return Math.max(
    0,
    ...headerValues(rawHeaderText(raw), FORWARD_HOP_HEADER).flatMap((value) =>
      /^\d{1,6}$/u.test(value) ? [Number(value)] : []
    )
  );
}

/** What resolving an address reads of a `mailboxes` row. */
export type AddressRow = {
  id: string;
  localPart: string;
  catchAll: boolean;
  delivery: MailboxDelivery;
  aliasOf: string | null;
  forwardTo: string[] | null;
};

/** `sam` for `sam+shop`; null without a tag. */
function plusBase(localPart: string) {
  const plus = localPart.indexOf("+");

  return plus > 0 ? localPart.slice(0, plus) : null;
}

/**
 * Which of a domain's candidate rows takes mail for `localPart`: the exact
 * address, else its plus base (`sam+shop` → `sam`), else the catch-all.
 */
export function pickAddress<Row extends AddressRow>(
  rows: readonly Row[],
  localPart: string
) {
  const base = plusBase(localPart);

  return (
    rows.find((row) => row.localPart === localPart) ??
    (base === null ? undefined : rows.find((row) => row.localPart === base)) ??
    rows.find((row) => row.catchAll) ??
    null
  );
}

const routeColumns = {
  id: mailboxes.id,
  localPart: mailboxes.localPart,
  catchAll: mailboxes.catchAll,
  teamId: mailboxes.teamId,
  delivery: mailboxes.delivery,
  listPosting: mailboxes.listPosting,
  aliasOf: mailboxes.aliasOf,
  forwardTo: mailboxes.forwardTo,
};

type RouteRow = AddressRow & {
  teamId: string | null;
  listPosting: (typeof mailboxes.$inferSelect)["listPosting"];
};

export type InboundRoute =
  | { kind: "mailbox"; mailbox: RouteRow }
  | { kind: "forward"; forwardTo: string[] };

/**
 * Where mail for a workspace address goes: the address itself, its plus
 * base, or its domain's catch-all; an alias delivers into its mailbox. Null
 * rejects it. One query, plus one for an alias's mailbox.
 */
export async function resolveInboundRoute(
  db: D1Database,
  address: string
): Promise<InboundRoute | null> {
  const recipient = normalizeMailboxAddress(address);
  const at = recipient.lastIndexOf("@");
  const localPart = recipient.slice(0, at);
  const domain = recipient.slice(at + 1);
  const base = plusBase(localPart);
  const orm = createDb(db);

  const rows = await orm
    .select(routeColumns)
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.domain, domain),
        or(
          inArray(mailboxes.localPart, base ? [localPart, base] : [localPart]),
          eq(mailboxes.catchAll, true)
        )
      )
    );

  const row = pickAddress(rows, localPart);

  if (!row) return null;

  if (row.delivery === "forward") {
    return { kind: "forward", forwardTo: row.forwardTo ?? [] };
  }

  if (row.delivery !== "alias") return { kind: "mailbox", mailbox: row };

  if (!row.aliasOf) return null;

  const [target] = await orm
    .select(routeColumns)
    .from(mailboxes)
    .where(eq(mailboxes.id, row.aliasOf))
    .limit(1);

  return target && (target.delivery === "inbox" || target.delivery === "list")
    ? { kind: "mailbox", mailbox: target }
    : null;
}

/**
 * Why a message must not be forwarded, or null. Forwarding happens as mail
 * arrives, before any mailbox's spam classifier runs, so it goes by what is
 * known then: the hop limit, a sender blocked for the whole workspace, and
 * mail that failed DMARC.
 */
async function forwardRefusal(
  db: D1Database,
  message: { from: string },
  raw: ArrayBuffer
) {
  if (forwardHops(raw) >= MAX_FORWARD_HOPS) return "forwarded too many times";

  const headers = rawHeaderText(raw);

  // ponytail: the last address in the From header, enough for a block
  // lookup; delivery parses it fully with postal-mime later.
  const from =
    /([^\s<>",;:]+@[^\s<>",;:]+)>?\s*$/u.exec(
      headerValues(headers, "from")[0] ?? ""
    )?.[1] ?? null;

  const authentication = parseInboundAuthentication({
    raw: headers,
    fromAddress: from,
    envelopeFrom: message.from,
  });

  if (authentication.dmarc?.result === "fail") return "failed DMARC";

  const blocks = await workspaceBlockPatterns(db);

  return [message.from, from].some(
    (address) => address && workspaceBlockFor(address, blocks)
  )
    ? "blocked sender"
    : null;
}

/**
 * Forwards a message unchanged through Email Routing, so the original
 * sender stays and its DKIM signature still verifies: only to destinations
 * that confirmed Cloudflare's email, never to the sender itself, and each
 * forward adds one to the hop header.
 */
export async function forwardInbound(input: {
  env: Env;
  message: ForwardableEmailMessage;
  raw: ArrayBuffer;
  forwardTo: string[];
}) {
  const { env, message, raw } = input;
  const recipient = normalizeMailboxAddress(message.to);
  const refusal = await forwardRefusal(env.DB, message, raw);

  // Accepted and dropped, like spam that is never shown: the sender learns
  // nothing about the address or its block.
  if (refusal) {
    console.warn(`Not forwarding mail for ${recipient}: ${refusal}`);

    return;
  }

  const sender = normalizeMailboxAddress(message.from);
  const statuses = await destinationStatuses(env);

  const destinations = input.forwardTo.filter(
    (destination) =>
      normalizeMailboxAddress(destination) !== sender &&
      statuses?.get(destination.toLowerCase()) === "confirmed"
  );

  if (!destinations.length) {
    message.setReject(`${recipient} has no confirmed address to forward to`);

    return;
  }

  const hops = String(forwardHops(raw) + 1);

  const results = await Promise.allSettled(
    destinations.map((destination) =>
      message.forward(destination, new Headers({ [FORWARD_HOP_HEADER]: hops }))
    )
  );

  for (const result of results) {
    if (result.status === "rejected") {
      console.error(`Could not forward mail for ${recipient}`, result.reason);
    }
  }

  // When every forward failed, throwing doesn't make the sending server try
  // again: Cloudflare answers it 521 5.3.0, and the sender gets a bounce.
  if (results.every((result) => result.status === "rejected")) {
    throw new Error(`Forwarding mail for ${recipient} failed`);
  }
}
