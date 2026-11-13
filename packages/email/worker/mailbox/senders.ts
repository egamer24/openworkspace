import { blockPatternsFor } from "../../shared/mail-feedback";
import type {
  FeedbackLabel,
  SenderBlock,
  SenderStatus,
} from "../../shared/mail-feedback";
import type { SenderHistory } from "../mail/message-security";
import type { NewEmail } from "./schema";

function normalized(address: string | null | undefined) {
  const value = address?.trim().toLocaleLowerCase() ?? "";
  const at = value.lastIndexOf("@");

  return at > 0 && at < value.length - 1
    ? { address: value, domain: value.slice(at + 1) }
    : null;
}

function timestamp(value: NewEmail["timelineAt"]) {
  return value instanceof Date ? value.getTime() : Number(value);
}

/**
 * Upserts the correspondent counters for one stored message. Call it inside
 * the transaction that inserted the row so counts never drift from `emails`.
 */
export function recordCorrespondents(sql: SqlStorage, email: NewEmail) {
  const at = timestamp(email.timelineAt);

  if (email.direction === "incoming") {
    const sender = normalized(email.fromJson[0]?.address);

    if (!sender) return;
    sql.exec(
      `insert into senders (address, domain, first_seen_at, last_seen_at, message_count)
       values (?, ?, ?, ?, 1)
       on conflict (address) do update set
         first_seen_at = min(coalesce(first_seen_at, excluded.first_seen_at), excluded.first_seen_at),
         last_seen_at = max(coalesce(last_seen_at, excluded.last_seen_at), excluded.last_seen_at),
         message_count = message_count + 1`,
      sender.address,
      sender.domain,
      at,
      at
    );

    return;
  }

  const recipients = new Map<string, string>();

  for (const recipient of [
    ...(email.toJson ?? []),
    ...(email.ccJson ?? []),
    ...(email.bccJson ?? []),
  ]) {
    const value = normalized(recipient.address);

    if (value) recipients.set(value.address, value.domain);
  }

  for (const [address, domain] of recipients) {
    sql.exec(
      `insert into senders (address, domain, outbound_count, last_outbound_at)
       values (?, ?, 1, ?)
       on conflict (address) do update set
         outbound_count = outbound_count + 1,
         last_outbound_at = max(coalesce(last_outbound_at, excluded.last_outbound_at), excluded.last_outbound_at)`,
      address,
      domain,
      at
    );
  }
}

type SenderHistoryRow = {
  address: string;
  message_count: number;
  outbound_count: number;
};

export function senderHistory(sql: SqlStorage, addresses: string[]) {
  const unique = [
    ...new Set(addresses.map((address) => address.toLocaleLowerCase())),
  ].slice(0, 100);

  const result = new Map<string, SenderHistory>();

  if (!unique.length) return result;

  const rows = sql
    .exec<SenderHistoryRow>(
      `select address, message_count, outbound_count from senders where address in (${unique.map(() => "?").join(", ")})`,
      ...unique
    )
    .toArray();

  for (const row of rows) {
    result.set(row.address, {
      inboundCount: Number(row.message_count),
      outboundCount: Number(row.outbound_count),
    });
  }

  return result;
}

type BlockRow = { address: string; blocked_at: number };

/** The most specific mailbox block covering an address, if any. */
export function mailboxBlockFor(
  sql: SqlStorage,
  address: string
): SenderBlock | null {
  const patterns = blockPatternsFor(address);

  if (!patterns.length) return null;

  const rows = sql
    .exec<BlockRow>(
      `select address, blocked_at from senders
     where blocked_at is not null and address in (${patterns.map(() => "?").join(", ")})`,
      ...patterns
    )
    .toArray();

  const pattern = patterns.find((candidate) =>
    rows.some((row) => row.address === candidate)
  );

  const row = rows.find((candidate) => candidate.address === pattern);

  return row
    ? blockFromPattern(row.address, Number(row.blocked_at), false)
    : null;
}

export function blockFromPattern(
  pattern: string,
  at: number,
  workspace: boolean
): SenderBlock {
  return {
    pattern,
    scope: pattern.startsWith("@") ? "domain" : "address",
    workspace,
    at,
  };
}

/** First workspace-wide pattern (address before domains) that covers an address. */
export function workspaceBlockFor(
  address: string,
  patterns: ReadonlyMap<string, number>
) {
  for (const pattern of blockPatternsFor(address)) {
    const blockedAt = patterns.get(pattern);

    if (blockedAt !== undefined) {
      return blockFromPattern(pattern, blockedAt, true);
    }
  }

  return null;
}

type StatusRow = {
  address: string;
  trusted_at: number | null;
  reported_at: number | null;
};

/** Block, trust and report state of each address in this mailbox (lowercased keys). */
export function senderStatuses(sql: SqlStorage, addresses: string[]) {
  const unique = [
    ...new Set(addresses.map((address) => address.toLocaleLowerCase())),
  ].slice(0, 100);

  const result = new Map<string, SenderStatus>();

  if (!unique.length) return result;

  const rows = sql
    .exec<StatusRow>(
      `select address, trusted_at, reported_at from senders where address in (${unique.map(() => "?").join(", ")})`,
      ...unique
    )
    .toArray();

  const byAddress = new Map(rows.map((row) => [row.address, row]));

  for (const address of unique) {
    const row = byAddress.get(address);
    result.set(address, {
      block: mailboxBlockFor(sql, address),
      trustedAt: row?.trusted_at == null ? null : Number(row.trusted_at),
      reportedAt: row?.reported_at == null ? null : Number(row.reported_at),
    });
  }

  return result;
}

function patternDomain(pattern: string) {
  return pattern.startsWith("@")
    ? pattern.slice(1)
    : pattern.slice(pattern.lastIndexOf("@") + 1);
}

/** Blocking clears trust: the two decisions are mutually exclusive. */
export function setSenderBlocked(
  sql: SqlStorage,
  pattern: string,
  blocked: boolean,
  now: number
) {
  if (!blocked) {
    sql.exec("update senders set blocked_at = null where address = ?", pattern);

    return;
  }

  sql.exec(
    `insert into senders (address, domain, blocked_at) values (?, ?, ?)
     on conflict (address) do update set blocked_at = excluded.blocked_at, trusted_at = null`,
    pattern,
    patternDomain(pattern),
    now
  );
}

/** Trusting an address also lifts a block on that exact address. */
export function setSenderTrusted(
  sql: SqlStorage,
  address: string,
  trusted: boolean,
  now: number
) {
  const value = address.toLocaleLowerCase();

  if (!trusted) {
    sql.exec("update senders set trusted_at = null where address = ?", value);

    return;
  }

  sql.exec(
    `insert into senders (address, domain, trusted_at) values (?, ?, ?)
     on conflict (address) do update set trusted_at = excluded.trusted_at, blocked_at = null`,
    value,
    patternDomain(value),
    now
  );
}

export type BlockedSenderItem = {
  pattern: string;
  scope: "address" | "domain";
  blockedAt: number;
  messageCount: number;
};

export function listBlockedSenders(sql: SqlStorage): BlockedSenderItem[] {
  return sql
    .exec<{ address: string; blocked_at: number; message_count: number }>(
      "select address, blocked_at, message_count from senders where blocked_at is not null order by blocked_at desc limit 500"
    )
    .toArray()
    .map((row) => ({
      pattern: row.address,
      scope: row.address.startsWith("@") ? "domain" : "address",
      blockedAt: Number(row.blocked_at),
      messageCount: Number(row.message_count),
    }));
}

export function recordSenderFeedback(
  sql: SqlStorage,
  input: {
    id: string;
    address: string;
    emailId: string | null;
    label: FeedbackLabel;
    userId: string | null;
    now: number;
  }
) {
  const address = input.address.toLocaleLowerCase();
  const domain = patternDomain(address);
  sql.exec(
    `insert into sender_feedback (id, address, domain, email_id, label, user_id, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    address,
    domain,
    input.emailId,
    input.label,
    input.userId,
    input.now
  );

  if (input.label === "not_spam") return;
  sql.exec(
    `insert into senders (address, domain, reported_at) values (?, ?, ?)
     on conflict (address) do update set reported_at = excluded.reported_at, trusted_at = null`,
    address,
    domain,
    input.now
  );
}

/**
 * Report history for the classifier: what people in this mailbox said about
 * the sender before. Every label other than "not_spam" counts as a report.
 */
export function senderFeedbackSummary(sql: SqlStorage, address: string) {
  const value = address.toLocaleLowerCase();
  const domain = patternDomain(value);

  const rows = sql
    .exec<{ not_spam: number; same_address: number; count: number }>(
      `select label = 'not_spam' as not_spam, address = ? as same_address, count(*) as count
     from sender_feedback where domain = ? group by label = 'not_spam', address = ?`,
      value,
      domain,
      value
    )
    .toArray();

  const count = (notSpam: boolean, sameAddress: boolean) =>
    rows
      .filter(
        (row) =>
          Boolean(row.not_spam) === notSpam &&
          (!sameAddress || Boolean(row.same_address))
      )
      .reduce((total, row) => total + Number(row.count), 0);

  return {
    spamReports: count(false, true),
    notSpam: count(true, true),
    domainReports: count(false, false),
  };
}

export type SenderFeedbackSummary = ReturnType<typeof senderFeedbackSummary>;
