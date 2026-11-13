import { createDb } from "@open-workspace/core/module";
import { and, desc, eq, ne } from "drizzle-orm";

import type { FeedbackLabel } from "../../shared/mail-feedback";
import { blockedSenders, senderReports } from "../db/schema";
import { isolateCache, WORKSPACE_CACHE_TTL_MS } from "./isolate-cache";

const MAX_WORKSPACE_BLOCKS = 5000;

/** Workspace-wide block patterns with the time each was added. */
export async function workspaceBlockPatterns(binding: D1Database) {
  const rows = await createDb(binding)
    .select({
      pattern: blockedSenders.pattern,
      createdAt: blockedSenders.createdAt,
    })
    .from(blockedSenders)
    .orderBy(desc(blockedSenders.createdAt))
    .limit(MAX_WORKSPACE_BLOCKS);

  return new Map(rows.map((row) => [row.pattern, row.createdAt.getTime()]));
}

const blockPatternCache = isolateCache(
  WORKSPACE_CACHE_TTL_MS,
  workspaceBlockPatterns
);

/**
 * `workspaceBlockPatterns` reused for up to a minute in this isolate, for
 * showing mail. Changes made through this isolate drop it at once (see
 * `forgetWorkspaceBlockPatterns`); others show within the minute. Delivery
 * and blocking decisions read it fresh.
 */
export function cachedWorkspaceBlockPatterns(binding: D1Database) {
  return blockPatternCache.get(binding);
}

export function forgetWorkspaceBlockPatterns() {
  blockPatternCache.clear();
}

function addressDomain(address: string) {
  return address.slice(address.lastIndexOf("@") + 1);
}

/** Shares a spam or not-spam verdict with the rest of the workspace. */
export async function recordWorkspaceFeedback(
  binding: D1Database,
  input: {
    mailboxId: string;
    emailId: string;
    address: string;
    label: FeedbackLabel;
  }
) {
  const address = input.address.toLocaleLowerCase();

  if (!address.includes("@")) return;
  const db = createDb(binding);

  const row = {
    mailboxId: input.mailboxId,
    emailId: input.emailId,
    address,
    domain: addressDomain(address),
    label: input.label,
    createdAt: new Date(),
  };

  // A new stance replaces the opposite one this mailbox gave the sender before.
  const opposite =
    input.label === "not_spam"
      ? ne(senderReports.label, "not_spam")
      : eq(senderReports.label, "not_spam");

  await db.batch([
    db
      .delete(senderReports)
      .where(
        and(
          eq(senderReports.mailboxId, input.mailboxId),
          eq(senderReports.address, address),
          opposite
        )
      ),
    db
      .insert(senderReports)
      .values(row)
      .onConflictDoUpdate({
        target: [senderReports.mailboxId, senderReports.emailId],
        set: { label: row.label, createdAt: row.createdAt },
      }),
  ]);
}

/** Verdicts other mailboxes in the workspace gave this sender and its domain. */
export async function workspaceFeedbackSummary(
  binding: D1Database,
  mailboxId: string,
  address: string
) {
  const value = address.toLocaleLowerCase();

  const [groups, reporters] = await binding.batch<
    {
      label: FeedbackLabel;
      same_address: number;
      count: number;
    } & { mailboxes: number }
  >([
    binding
      .prepare(`
      select label, address = ?1 as same_address, count(*) as count
      from sender_reports
      where domain = ?2 and mailbox_id <> ?3
      group by label, address = ?1
    `)
      .bind(value, addressDomain(value), mailboxId),
    binding
      .prepare(`
      select count(distinct mailbox_id) as mailboxes
      from sender_reports
      where address = ?1 and label <> 'not_spam' and mailbox_id <> ?2
    `)
      .bind(value, mailboxId),
  ]);

  const rows = groups?.results ?? [];

  const count = (labels: FeedbackLabel[], sameAddress: boolean) =>
    rows
      .filter(
        (row) =>
          labels.includes(row.label) &&
          Boolean(row.same_address) === sameAddress
      )
      .reduce((total, row) => total + Number(row.count), 0);

  return {
    spamReports: count(["spam"], true),
    notSpam: count(["not_spam"], true),
    domainReports: count(["spam"], false),
    /** How many other mailboxes reported this exact address. */
    reportingMailboxes: Number(reporters?.results[0]?.mailboxes ?? 0),
  };
}

export type WorkspaceFeedbackSummary = Awaited<
  ReturnType<typeof workspaceFeedbackSummary>
>;
