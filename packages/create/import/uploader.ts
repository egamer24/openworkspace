import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { forEachConcurrent } from "./concurrency.ts";
import { MAX_IMPORT_MESSAGE_BYTES } from "./protocol.ts";
import type { ImportItem, SkippedItem } from "./protocol.ts";
import { WorkspaceError } from "./workspace.ts";
import type { Workspace } from "./workspace.ts";

/**
 * What a run already did, so it can resume: one file of imported source
 * ids (appended as each message lands) and one of failures, per import job.
 * Failed messages are tried again on the next run.
 */
export class ResumeState {
  private readonly done = new Set<string>();
  private readonly donePath: string;
  private readonly failedPath: string;

  constructor(directory: string, job: string) {
    mkdirSync(directory, { recursive: true });
    const name = job.replaceAll(/[^a-zA-Z0-9._@-]+/gu, "_").slice(0, 120);
    this.donePath = join(directory, `${name}.done`);
    this.failedPath = join(directory, `${name}.failed.jsonl`);

    if (existsSync(this.donePath)) {
      for (const line of readFileSync(this.donePath, "utf-8").split("\n")) {
        if (line) this.done.add(line);
      }
    }
  }

  get size() {
    return this.done.size;
  }

  has(sourceId: string) {
    return this.done.has(sourceId);
  }

  add(sourceId: string) {
    if (this.done.has(sourceId)) return;
    this.done.add(sourceId);
    appendFileSync(this.donePath, `${sourceId}\n`);
  }

  fail(sourceId: string, reason: string) {
    appendFileSync(
      this.failedPath,
      `${JSON.stringify({ sourceId, reason, at: new Date().toISOString() })}\n`
    );
  }

  get failuresPath() {
    return this.failedPath;
  }
}

export type UploadStats = {
  /** Messages the source has, when it was counted first. */
  total: number | null;
  seen: number;
  imported: number;
  duplicate: number;
  /** Already imported by an earlier run. */
  resumed: number;
  skipped: number;
  failed: number;
  bytes: number;
  /** Labels that could not become folders (the folder limit, or a system folder's name). */
  folderSkipped: number;
};

/** Errors worth trying again: the network, rate limits, the server having a bad moment. */
function retryable(cause: unknown) {
  if (cause instanceof WorkspaceError) {
    return cause.status === 429 || cause.status >= 500;
  }

  return true;
}

/** Errors that end the run: every message would fail the same way. */
function fatal(cause: unknown) {
  return (
    cause instanceof WorkspaceError && [401, 403, 404].includes(cause.status)
  );
}

/** What the uploader needs from the workspace; tests give a stand-in. */
export type ImportDestination = Pick<
  Workspace,
  "importMessage" | "finishImport"
>;

export type UploadOptions = {
  workspace: ImportDestination;
  mailboxId: string;
  items:
    | AsyncIterable<ImportItem | SkippedItem>
    | Iterable<ImportItem | SkippedItem>;
  state: ResumeState;
  /** Requests in flight; a mailbox stores one message at a time, so 2–4 is plenty. */
  concurrency: number;
  total?: number | null;
  retries?: number;
  /** Delay before retry `attempt` (from 1); tests make it short. */
  backoff?: (attempt: number) => number;
  onProgress?: (stats: UploadStats) => void;
};

/**
 * Uploads every item with bounded concurrency, retrying transient failures
 * and recording each result, then announces the batch to the mailbox.
 */
export async function upload(options: UploadOptions): Promise<UploadStats> {
  const stats: UploadStats = {
    total: options.total ?? null,
    seen: 0,
    imported: 0,
    duplicate: 0,
    resumed: 0,
    skipped: 0,
    failed: 0,
    bytes: 0,
    folderSkipped: 0,
  };

  const retries = options.retries ?? 6;

  const backoff =
    options.backoff ??
    ((attempt) => Math.min(30_000, 1000 * 2 ** (attempt - 1)));

  const progress = () => options.onProgress?.(stats);

  /** Sends one message, retrying transient failures; a fatal one rejects and ends the run. */
  const send = async (item: ImportItem, attempt = 1): Promise<void> => {
    try {
      const result = await options.workspace.importMessage(
        options.mailboxId,
        item
      );

      if (result.status === "duplicate") stats.duplicate += 1;
      else {
        stats.imported += 1;

        if (result.folderSkipped) stats.folderSkipped += 1;
      }

      stats.bytes += item.raw.byteLength;
      options.state.add(item.sourceId);
    } catch (error) {
      if (fatal(error)) throw error;

      if (!retryable(error) || attempt > retries) {
        stats.failed += 1;
        options.state.fail(
          item.sourceId,
          error instanceof Error ? error.message : String(error)
        );

        return;
      }

      await Bun.sleep(backoff(attempt));

      return send(item, attempt + 1);
    }
  };

  const handle = async (item: ImportItem | SkippedItem) => {
    stats.seen += 1;

    if (options.state.has(item.sourceId)) {
      stats.resumed += 1;
      progress();

      return;
    }

    if ("skipped" in item) {
      stats.skipped += 1;
      progress();

      return;
    }

    if (item.raw.byteLength > MAX_IMPORT_MESSAGE_BYTES) {
      stats.failed += 1;
      options.state.fail(
        item.sourceId,
        `Larger than ${MAX_IMPORT_MESSAGE_BYTES / 1024 / 1024} MiB`
      );
      progress();

      return;
    }

    try {
      await send(item);
    } finally {
      progress();
    }
  };

  await forEachConcurrent(options.items, options.concurrency, handle);
  await options.workspace.finishImport(options.mailboxId);

  return stats;
}

/** A one-line progress report for a terminal. */
export function progressLine(label: string, stats: UploadStats) {
  const done =
    stats.imported +
    stats.duplicate +
    stats.resumed +
    stats.skipped +
    stats.failed;

  const of = stats.total === null ? "" : `/${stats.total}`;
  const parts = [`${stats.imported} imported`];

  if (stats.duplicate) parts.push(`${stats.duplicate} already there`);

  if (stats.resumed) parts.push(`${stats.resumed} done before`);

  if (stats.skipped) parts.push(`${stats.skipped} skipped`);

  if (stats.failed) parts.push(`${stats.failed} failed`);

  return `${label}: ${done}${of} — ${parts.join(", ")} (${(stats.bytes / 1024 / 1024).toFixed(1)} MiB sent)`;
}
