import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  folderName,
  gmailMessage,
  parseGmailLabelsHeader,
  ThreadFolders,
} from "./gmail.ts";
import type { GmailOptions } from "./gmail.ts";
import { header, headerText, parseHeaders, rootThreadKey } from "./headers.ts";
import type { HeaderFields } from "./headers.ts";
import { fromLineDate, readMbox } from "./mbox.ts";
import type { MboxMessage } from "./mbox.ts";
import { MAX_IMPORT_MESSAGE_BYTES } from "./protocol.ts";
import type { ImportItem, Placement, SkippedItem } from "./protocol.ts";

/**
 * Mail from mbox files: a Google Takeout export (its X-Gmail-Labels and
 * X-GM-THRID headers give each message's place, read state and thread) or
 * any other mbox (one place for all of it, read state from Status).
 */

export type MboxSourceOptions = GmailOptions & {
  /** Labels to prefer as a thread's folder, in order. */
  folderPriority: string[];
  /** Places not to import (e.g. spam, trash). */
  skip: Set<Placement>;
  /** For mbox files without Gmail labels: where the mail goes, and in which folder. */
  placement: Placement;
  folder: string | null;
};

/** The mbox files at these paths: files as given, directories searched for *.mbox (a Takeout folder). */
export function mboxFiles(paths: string[]) {
  const files: string[] = [];

  const walk = (path: string) => {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path).sort()) walk(join(path, entry));
    } else if (path.toLowerCase().endsWith(".mbox") || paths.includes(path)) {
      files.push(path);
    }
  };

  for (const path of paths) walk(path);

  return files;
}

/**
 * The files' messages, one file after another.
 * @yields {MboxMessage} Each message of each file, in order.
 */
async function* messages(files: string[]) {
  for (const file of files) {
    yield* readMbox(Bun.file(file).stream(), {
      maxBytes: MAX_IMPORT_MESSAGE_BYTES,
    });
  }
}

function threadOf(fields: HeaderFields) {
  const gmailThread = header(fields, "x-gm-thrid");

  return gmailThread ? `gmail:${gmailThread}` : rootThreadKey(fields);
}

/** First pass: how many messages there are, and which labels each Gmail thread carries. */
export async function scanMbox(files: string[], options: MboxSourceOptions) {
  const threads = new ThreadFolders(options.folderPriority);
  let count = 0;
  let bytes = 0;

  for await (const message of messages(files)) {
    count += 1;
    bytes += message.size;

    if (message.tooLarge) continue;
    const fields = parseHeaders(headerText(message.raw));
    const labels = header(fields, "x-gmail-labels");
    const thread = threadOf(fields);

    if (labels !== undefined && thread) {
      threads.add(
        thread,
        gmailMessage(parseGmailLabelsHeader(labels), options).userLabels
      );
    }
  }

  return { count, bytes, threads };
}

/** Read state from a Status header (R is read); mail without one is old, so read. */
function statusSeen(fields: HeaderFields) {
  const status = header(fields, "status");

  return status === undefined ? true : status.includes("R");
}

/** What to import for one mbox message, or why it is skipped. */
export function mboxItem(
  message: MboxMessage,
  options: MboxSourceOptions,
  threads: ThreadFolders
): ImportItem | SkippedItem {
  if (message.tooLarge) {
    return {
      sourceId: `mbox-large:${message.fromLine}:${message.size}`,
      skipped: "too large",
    };
  }

  const sourceId = `mbox:${new Bun.CryptoHasher("sha256").update(message.raw).digest("hex")}`;
  const fields = parseHeaders(headerText(message.raw));
  const thread = threadOf(fields);
  const receivedAt = fromLineDate(message.fromLine);
  const labels = header(fields, "x-gmail-labels");

  if (labels === undefined) {
    if (options.skip.has(options.placement)) {
      return { sourceId, skipped: options.placement };
    }

    return {
      sourceId,
      raw: message.raw,
      placement: options.placement,
      folder: options.placement === "inbox" ? options.folder : null,
      seen: statusSeen(fields),
      thread,
      receivedAt,
    };
  }

  const gmail = gmailMessage(parseGmailLabelsHeader(labels), options);

  if (gmail.skip) return { sourceId, skipped: gmail.skip };

  if (options.skip.has(gmail.placement)) {
    return { sourceId, skipped: gmail.placement };
  }

  const folder =
    gmail.placement === "inbox" && thread
      ? threads.folder(thread, gmail.userLabels)
      : gmail.placement === "inbox" && gmail.userLabels[0]
        ? folderName(gmail.userLabels[0])
        : null;

  return {
    sourceId,
    raw: message.raw,
    placement: gmail.placement,
    folder,
    // Takeout says Unread or Opened; neither is old mail, read.
    seen: gmail.seen ?? true,
    thread,
    receivedAt,
    // Gmail's Sent label says it, not the From address (which may be an alias).
    direction: gmail.sent ? "outgoing" : "incoming",
  };
}

export async function* mboxItems(
  files: string[],
  options: MboxSourceOptions,
  threads: ThreadFolders
) {
  for await (const message of messages(files)) {
    yield mboxItem(message, options, threads);
  }
}
