import type { FetchMessageObject, ImapFlow, ListResponse } from "imapflow";

import { gmailMessage, ThreadFolders } from "./gmail.ts";
import type { GmailOptions } from "./gmail.ts";
import { headerText, parseHeaders, rootThreadKey } from "./headers.ts";
import { MAX_IMPORT_MESSAGE_BYTES } from "./protocol.ts";
import type { ImportItem, Placement, SkippedItem } from "./protocol.ts";

/**
 * Mail from an IMAP account. Gmail (X-GM-EXT-1) is read from "[Gmail]/All
 * Mail" alone, with its labels (X-GM-LABELS) and threads (X-GM-THRID): its
 * label folders hold the same messages again. Other servers are read folder
 * by folder, each placed by its special use (RFC 6154).
 */

export type ImapSourceOptions = GmailOptions & {
  folderPriority: string[];
  skip: Set<Placement>;
  /** Names the account in source ids (host and user), so two accounts never collide. */
  account: string;
  /** Has this source id been imported already? Its body is then not downloaded. */
  done: (sourceId: string) => boolean;
  /** Messages fetched per round trip. */
  batchSize?: number;
};

/** Where a folder's mail goes on a server without Gmail labels. */
export type FolderPlan = {
  path: string;
  placement: Placement;
  /** A custom folder, for mail placed in the Inbox. */
  folder: string | null;
  direction?: "incoming" | "outgoing";
};

/** Folders that hold copies or nothing to import: drafts, virtual views, and the all-mail view. */
const SKIPPED_USES = new Set(["\\Drafts", "\\All", "\\Flagged", "\\Important"]);

/**
 * Each selectable folder's place: Inbox, Sent (sent mail), Junk (Spam),
 * Trash, Archive, and other folders as Archive or their own folder
 * (`archivedLabels`). Nested names use "/".
 */
export function folderPlans(
  folders: Pick<ListResponse, "path" | "delimiter" | "flags" | "specialUse">[],
  options: GmailOptions
): FolderPlan[] {
  return folders.flatMap((folder): FolderPlan[] => {
    if (folder.flags?.has("\\Noselect") || folder.flags?.has("\\NonExistent")) {
      return [];
    }

    const use =
      folder.specialUse ??
      (folder.path.toUpperCase() === "INBOX" ? "\\Inbox" : undefined);

    if (use && SKIPPED_USES.has(use)) return [];

    switch (use) {
      case "\\Inbox": {
        return [{ path: folder.path, placement: "inbox", folder: null }];
      }

      case "\\Sent": {
        return [
          {
            path: folder.path,
            placement: "sent",
            folder: null,
            direction: "outgoing",
          },
        ];
      }

      case "\\Junk": {
        return [{ path: folder.path, placement: "spam", folder: null }];
      }

      case "\\Trash": {
        return [{ path: folder.path, placement: "trash", folder: null }];
      }

      case "\\Archive": {
        return [{ path: folder.path, placement: "archive", folder: null }];
      }

      default: {
        // Any other folder, special use or not: placed by `archivedLabels` below.
        break;
      }
    }

    const delimiter = folder.delimiter || "/";
    // Courier and Dovecot setups nest everything under INBOX.
    const parts = folder.path.split(delimiter);
    const [top = ""] = parts;

    if (parts.length > 1 && top.toUpperCase() === "INBOX") parts.shift();
    const name = parts.join("/").slice(0, 80);

    return [
      options.archivedLabels === "folder"
        ? { path: folder.path, placement: "inbox", folder: name }
        : { path: folder.path, placement: "archive", folder: null },
    ];
  });
}

function receivedAt(message: FetchMessageObject) {
  if (!message.internalDate) return undefined;
  const time = new Date(message.internalDate).getTime();

  return Number.isFinite(time) ? time : undefined;
}

function labelsOf(message: FetchMessageObject) {
  return [...(message.labels ?? [])];
}

export type ImapSource = {
  gmail: boolean;
  /** Messages to go through (after skipping folders), counted before any body is fetched. */
  total: number;
  items: AsyncIterable<ImportItem | SkippedItem>;
};

type Work = {
  uid: number;
  sourceId: string;
  size?: number;
  meta: FetchMessageObject;
};

async function* fetchBodies(
  client: ImapFlow,
  work: Work[],
  batchSize: number,
  toItem: (
    meta: FetchMessageObject,
    sourceId: string,
    raw: Uint8Array<ArrayBuffer>
  ) => ImportItem | SkippedItem
): AsyncGenerator<ImportItem | SkippedItem> {
  for (let start = 0; start < work.length; start += batchSize) {
    const batch = work.slice(start, start + batchSize);
    const byUid = new Map(batch.map((entry) => [entry.uid, entry]));
    const fetched: (ImportItem | SkippedItem)[] = [];

    // Collected per batch: imapflow cannot run another command while a FETCH streams.
    // oxlint-disable-next-line eslint/no-await-in-loop -- one IMAP connection runs one command at a time, and the next batch is fetched only once this one is consumed
    const messages = await client.fetchAll(
      batch.map((entry) => entry.uid).join(","),
      { uid: true, source: true },
      { uid: true }
    );

    for (const message of messages) {
      const entry = byUid.get(message.uid);

      if (!entry || !message.source) continue;
      byUid.delete(message.uid);
      fetched.push(
        toItem(entry.meta, entry.sourceId, new Uint8Array(message.source))
      );
    }

    yield* fetched;

    // Gone since it was listed (expunged meanwhile).
    for (const entry of byUid.values()) {
      yield { sourceId: entry.sourceId, skipped: "gone" };
    }
  }
}

function sortedWork(work: Work[], options: ImapSourceOptions) {
  const pending: Work[] = [];
  const done: SkippedItem[] = [];
  const large: SkippedItem[] = [];

  for (const entry of work) {
    if (options.done(entry.sourceId)) {
      done.push({ sourceId: entry.sourceId, skipped: "done" });
    } else if ((entry.size ?? 0) > MAX_IMPORT_MESSAGE_BYTES) {
      large.push({ sourceId: entry.sourceId, skipped: "too large" });
    } else pending.push(entry);
  }

  return { pending, done, large };
}

/** Gmail: All Mail, its labels and threads. */
async function gmailSource(
  client: ImapFlow,
  allMail: string,
  options: ImapSourceOptions
): Promise<ImapSource> {
  const lock = await client.getMailboxLock(allMail, { readOnly: true });

  try {
    const threads = new ThreadFolders(options.folderPriority);
    const work: Work[] = [];

    for await (const meta of client.fetch(
      "1:*",
      {
        uid: true,
        flags: true,
        labels: true,
        threadId: true,
        emailId: true,
        internalDate: true,
        size: true,
      },
      { uid: true }
    )) {
      const thread = meta.threadId ? `gmail:${meta.threadId}` : undefined;

      if (thread) {
        threads.add(thread, gmailMessage(labelsOf(meta), options).userLabels);
      }

      work.push({
        uid: meta.uid,
        size: meta.size,
        sourceId: `gmail:${meta.emailId ?? `${options.account}:${meta.uid}`}`,
        meta,
      });
    }

    const { pending, done, large } = sortedWork(work, options);

    // oxlint-disable-next-line no-inner-declarations -- the generator closes over this block's state
    async function* items() {
      // Report what earlier runs did, and what cannot be imported, before downloading.
      yield* done;
      yield* large;

      const bodiesLock = await client.getMailboxLock(allMail, {
        readOnly: true,
      });

      try {
        yield* fetchBodies(
          client,
          pending,
          options.batchSize ?? 50,
          (meta, sourceId, raw): ImportItem | SkippedItem => {
            const gmail = gmailMessage(labelsOf(meta), options);

            if (gmail.skip) return { sourceId, skipped: gmail.skip };

            if (options.skip.has(gmail.placement)) {
              return { sourceId, skipped: gmail.placement };
            }

            const thread = meta.threadId
              ? `gmail:${meta.threadId}`
              : rootThreadKey(parseHeaders(headerText(raw)));

            return {
              sourceId,
              raw,
              placement: gmail.placement,
              folder:
                gmail.placement === "inbox" && thread
                  ? threads.folder(thread, gmail.userLabels)
                  : null,
              seen: meta.flags?.has("\\Seen") ?? false,
              thread,
              receivedAt: receivedAt(meta),
              direction: gmail.sent ? "outgoing" : "incoming",
            };
          }
        );
      } finally {
        bodiesLock.release();
      }
    }

    return { gmail: true, total: work.length, items: items() };
  } finally {
    lock.release();
  }
}

/** A folder's messages, listed without their bodies. */
async function folderWork(
  client: ImapFlow,
  plan: FolderPlan,
  options: ImapSourceOptions
): Promise<Work[]> {
  const lock = await client.getMailboxLock(plan.path, { readOnly: true });

  try {
    const { mailbox } = client;

    if (!mailbox || mailbox.exists === 0) return [];
    const uidValidity = String(mailbox.uidValidity);

    const messages = await client.fetchAll(
      "1:*",
      { uid: true, flags: true, internalDate: true, size: true },
      { uid: true }
    );

    return messages.map((meta) => ({
      uid: meta.uid,
      size: meta.size,
      sourceId: `imap:${options.account}/${plan.path}/${uidValidity}/${meta.uid}`,
      meta,
    }));
  } finally {
    lock.release();
  }
}

/** Any other server: folder by folder. */
async function foldersSource(
  client: ImapFlow,
  options: ImapSourceOptions
): Promise<ImapSource> {
  const plans = folderPlans(await client.list(), options).filter(
    (plan) => !options.skip.has(plan.placement)
  );

  const perFolder: { plan: FolderPlan; work: Work[] }[] = [];
  let total = 0;

  for (const plan of plans) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one IMAP connection has one folder selected at a time
    const work = await folderWork(client, plan, options);
    total += work.length;
    perFolder.push({ plan, work });
  }

  async function* items() {
    for (const { plan, work } of perFolder) {
      const { pending, done, large } = sortedWork(work, options);
      yield* done;
      yield* large;

      if (!pending.length) continue;
      // oxlint-disable-next-line eslint/no-await-in-loop -- one IMAP connection has one folder selected at a time
      const lock = await client.getMailboxLock(plan.path, { readOnly: true });

      try {
        yield* fetchBodies(
          client,
          pending,
          options.batchSize ?? 50,
          (meta, sourceId, raw) => {
            const item: ImportItem = {
              sourceId,
              raw,
              placement: plan.placement,
              folder: plan.folder,
              seen: meta.flags?.has("\\Seen") ?? false,
              thread: rootThreadKey(parseHeaders(headerText(raw))),
              receivedAt: receivedAt(meta),
            };

            if (plan.direction) item.direction = plan.direction;

            return item;
          }
        );
      } finally {
        lock.release();
      }
    }
  }

  return { gmail: false, total, items: items() };
}

/** The account's mail as import items, Gmail or not. */
export async function imapSource(
  client: ImapFlow,
  options: ImapSourceOptions
): Promise<ImapSource> {
  if (client.capabilities.has("X-GM-EXT-1")) {
    const allMail = (await client.list()).find(
      (folder) => folder.specialUse === "\\All"
    );

    if (!allMail) {
      throw new Error(
        'This Gmail account shows no All Mail folder over IMAP; turn on "Show in IMAP" for All Mail in Gmail\'s settings'
      );
    }

    return gmailSource(client, allMail.path, options);
  }

  return foldersSource(client, options);
}
