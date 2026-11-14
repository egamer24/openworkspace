import { and, desc, eq, isNull, like, lt, or } from "drizzle-orm";

import { workspaceConfig } from "../config";
import { createDb } from "../db/client";
import type { Database } from "../db/client";
import { backupRuns } from "../db/schema";
import { workspaceModules } from "../modules";
import type { BackupSnapshot } from "../modules";
import { coreBackup } from "./core-data";

/**
 * Scheduled backups to BACKUP_STORAGE (`OpenWorkspace({ backups })`). Each
 * day the hourly cron starts one snapshot and writes it a batch at a time:
 *
 * - `backups/<id>/core.json`: people, teams, addresses, SSO apps, webhooks
 *   and branding, never secrets (core-data.ts).
 * - `backups/<id>/<module>/<folder>/<part>.jsonl`: each module's lines.
 * - `backups/objects/<sha256>.<extension>`: what lines name, stored once.
 *
 * `bunx @open-workspace/create import backup <folder>` restores one.
 */

export const BACKUP_PREFIX = "backups";

/** A tick stops starting batches after this long; the cron gives it 15 minutes. */
const CRON_BUDGET_MS = 8 * 60 * 1000;

/**
 * Batches a tick runs at most: each module keeps a batch to about 300
 * subrequests (mail: 100 new messages), so 25 stay well under the
 * 10,000 an invocation may make.
 */
const MAX_BATCHES = 25;
const LEASE_MS = 15 * 60 * 1000;
const MAX_RECORDED_ERRORS = 20;
const SWEEP_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

type BackupRun = typeof backupRuns.$inferSelect;

/** A snapshot's id from when it started, e.g. 2026-03-10T041700.000Z. */
export function backupId(now: Date) {
  const iso = now.toISOString();

  return `${iso.slice(0, 10)}T${iso.slice(11, 23).replaceAll(":", "")}Z`;
}

const DAY_MS = 86_400_000;

/**
 * The snapshots to keep: the newest of each day in the `keepDays` days up
 * to the newest snapshot, and of each ISO week in the `keepWeeks` weeks up
 * to it.
 */
export function retainedBackupIds(
  ids: string[],
  retention: { keepDays: number; keepWeeks: number }
) {
  const keep = new Set<string>();
  const seen = new Set<string>();
  const day = (id: string) => Date.parse(`${id.slice(0, 10)}T00:00:00Z`);

  const monday = (time: number) =>
    time - ((new Date(time).getUTCDay() + 6) % 7) * DAY_MS;

  const newestFirst = ids.toSorted().toReversed();
  const [newest] = newestFirst;

  if (!newest) return keep;

  for (const id of newestFirst) {
    const days = (day(newest) - day(id)) / DAY_MS;
    const weeks = (monday(day(newest)) - monday(day(id))) / (7 * DAY_MS);

    if (days < retention.keepDays && !seen.has(`d${day(id)}`)) keep.add(id);

    if (weeks < retention.keepWeeks && !seen.has(`w${monday(day(id))}`)) {
      keep.add(id);
    }

    seen.add(`d${day(id)}`);
    seen.add(`w${monday(day(id))}`);
  }

  return keep;
}

export function backupObjectKey(name: string) {
  return `${BACKUP_PREFIX}/objects/${name}`;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

/** The installed modules that back up, in install order. */
function backupModules() {
  return workspaceModules().filter((module) => module.backup);
}

/** The module after `name` that backs up, or null after the last. */
function nextModule(name: string | null) {
  const names = backupModules().map((module) => module.name);

  return (name === null ? names[0] : names[names.indexOf(name) + 1]) ?? null;
}

/** Starts a snapshot, unless one is running or, with `daily`, one started today. */
export async function startBackupRun(
  env: Env,
  now = new Date(),
  { daily = false } = {}
) {
  const bucket = env.BACKUP_STORAGE;

  if (!bucket) return null;
  const db = createDb(env.DB);
  const id = backupId(now);

  const [running] = await db
    .select({ id: backupRuns.id })
    .from(backupRuns)
    .where(
      daily
        ? or(
            eq(backupRuns.status, "running"),
            like(backupRuns.id, `${id.slice(0, 10)}%`)
          )
        : eq(backupRuns.status, "running")
    )
    .limit(1);

  if (running) return null;

  await bucket.put(
    `${BACKUP_PREFIX}/${id}/core.json`,
    JSON.stringify(await coreBackup(env, db), null, 2),
    { httpMetadata: { contentType: "application/json" } }
  );

  const [started] = await db
    .insert(backupRuns)
    .values({ id, status: "running", module: nextModule(null), startedAt: now })
    .onConflictDoNothing()
    .returning({ id: backupRuns.id });

  return started?.id ?? null;
}

/** One batch of the current module's part. */
async function moduleStep(
  env: Env,
  bucket: R2Bucket,
  db: Database,
  run: BackupRun,
  name: string
) {
  const module = backupModules().find((candidate) => candidate.name === name);
  const files = new Map<string, string>();
  const errors: string[] = [];
  let items = 0;
  let newObjects = 0;
  let newBytes = 0;

  const snapshot: BackupSnapshot = {
    id: run.id,
    cursor: run.cursor,
    async putObject(bytes, type) {
      const sha256 = await sha256Hex(bytes);
      const key = backupObjectKey(`${sha256}.${type.extension}`);

      if (!(await bucket.head(key))) {
        await bucket.put(key, bytes, {
          httpMetadata: { contentType: type.contentType },
          sha256,
        });
        newObjects += 1;
        newBytes += bytes.byteLength;
      }

      return sha256;
    },
    writeLines(folder, lines) {
      if (!/^[^/\\]+(?:\/[^/\\]+)*$/u.test(folder) || folder.includes("..")) {
        throw new Error(`Backup folder ${folder} is not a relative path`);
      }

      const text = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
      files.set(folder, (files.get(folder) ?? "") + text);
      items += lines.length;
    },
    error: (message) => errors.push(message),
  };

  // A module no longer installed has nothing more to write.
  const cursor = module?.backup
    ? await module.backup.export(env, snapshot)
    : null;

  const part = String(run.part).padStart(6, "0");

  await Promise.all(
    [...files].map(([folder, text]) =>
      bucket.put(
        `${BACKUP_PREFIX}/${run.id}/${name}/${folder}/${part}.jsonl`,
        text,
        {
          httpMetadata: { contentType: "application/x-ndjson" },
        }
      )
    )
  );

  const [updated] = await db
    .update(backupRuns)
    .set({
      module: cursor === null ? nextModule(name) : name,
      cursor,
      part: run.part + 1,
      itemCount: run.itemCount + items,
      newObjectCount: run.newObjectCount + newObjects,
      newObjectBytes: run.newObjectBytes + newBytes,
      errors: [...run.errors, ...errors].slice(-MAX_RECORDED_ERRORS),
    })
    .where(eq(backupRuns.id, run.id))
    .returning();

  return updated ?? run;
}

/** Every key under `prefix`, a page of R2's listing at a time. */
async function listKeys(bucket: R2Bucket, prefix: string) {
  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    // oxlint-disable-next-line eslint/no-await-in-loop -- R2 lists one page at a time
    const page = await bucket.list({ prefix, cursor });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return keys;
}

async function deleteKeys(bucket: R2Bucket, keys: string[]) {
  const deletes = [];

  // R2 deletes at most 1,000 keys a call.
  for (let index = 0; index < keys.length; index += 1000) {
    deletes.push(bucket.delete(keys.slice(index, index + 1000)));
  }

  await Promise.all(deletes);
}

/**
 * Deletes the objects no kept snapshot names. Only objects that existed
 * before this sweep listed the snapshots are considered, and no snapshot
 * runs meanwhile, so none is deleted that a line about to be written names.
 */
async function sweepObjects(bucket: R2Bucket, kept: string[]) {
  const objects = await listKeys(bucket, `${BACKUP_PREFIX}/objects/`);
  const named = new Set<string>();

  // ponytail: every named object's key is held in memory (~150 B each), so
  // about half a million distinct objects fit a Worker's 128 MB; past that,
  // sweep one hash prefix at a time.
  for (const id of kept) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one snapshot at a time
    const files = (await listKeys(bucket, `${BACKUP_PREFIX}/${id}/`)).filter(
      (key) => key.endsWith(".jsonl")
    );

    for (const key of files) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one file in memory at a time
      const text = (await (await bucket.get(key))?.text()) ?? "";

      for (const match of text.matchAll(/"object":"([^"]+)"/gu)) {
        if (match[1]) named.add(backupObjectKey(match[1]));
      }
    }
  }

  await deleteKeys(
    bucket,
    objects.filter((key) => !named.has(key))
  );
}

/**
 * After every module: deletes one snapshot outside retention a step, then
 * sweeps objects once a week, then completes the run.
 */
async function finishStep(
  bucket: R2Bucket,
  db: Database,
  run: BackupRun,
  retention: { keepDays: number; keepWeeks: number }
) {
  const runs = await db
    .select({
      id: backupRuns.id,
      swept: backupRuns.swept,
      startedAt: backupRuns.startedAt,
    })
    .from(backupRuns);

  const keep = retainedBackupIds(
    runs.map((row) => row.id),
    retention
  );

  const [expired] = runs
    .map((row) => row.id)
    .filter((id) => !keep.has(id))
    .toSorted();

  if (expired) {
    await deleteKeys(
      bucket,
      await listKeys(bucket, `${BACKUP_PREFIX}/${expired}/`)
    );
    await db.delete(backupRuns).where(eq(backupRuns.id, expired));

    return run;
  }

  const sweptRecently = runs.some(
    (row) =>
      row.swept &&
      run.startedAt.getTime() - row.startedAt.getTime() < SWEEP_EVERY_MS
  );

  if (!sweptRecently) await sweepObjects(bucket, [...keep]);

  const [completed] = await db
    .update(backupRuns)
    .set({
      status: "completed",
      finishedAt: new Date(),
      swept: !sweptRecently,
    })
    .where(eq(backupRuns.id, run.id))
    .returning();

  return completed ?? run;
}

/**
 * The hourly cron (and Run now): starts today's snapshot when there is
 * none, then continues the running one for `budgetMs`. A lease keeps two
 * ticks off the same run; an interrupted one is picked up once it lapses.
 */
export async function runBackupTick(
  env: Env,
  now = new Date(),
  budgetMs = CRON_BUDGET_MS
) {
  const bucket = env.BACKUP_STORAGE;
  const retention = workspaceConfig().backups;

  if (!bucket || !retention) return;
  const started = Date.now();
  const db = createDb(env.DB);
  await startBackupRun(env, now, { daily: true });

  const [leased] = await db
    .update(backupRuns)
    .set({ leaseUntil: new Date(started + LEASE_MS) })
    .where(
      and(
        eq(backupRuns.status, "running"),
        or(
          isNull(backupRuns.leaseUntil),
          lt(backupRuns.leaseUntil, new Date(started))
        )
      )
    )
    .returning();

  if (!leased) return;
  let run = leased;
  let failure: string | null = null;

  try {
    for (
      let batch = 0;
      batch < MAX_BATCHES &&
      run.status === "running" &&
      Date.now() - started < budgetMs;
      batch += 1
    ) {
      const step = run.module
        ? moduleStep(env, bucket, db, run, run.module)
        : finishStep(bucket, db, run, retention);

      // oxlint-disable-next-line eslint/no-await-in-loop -- each batch continues from the cursor the last one saved
      run = await step;
    }
  } catch (error) {
    console.error("Backup batch failed", error);
    failure = error instanceof Error ? error.message : String(error);
  }

  await db
    .update(backupRuns)
    .set({
      leaseUntil: null,
      errors: failure
        ? [...run.errors, failure].slice(-MAX_RECORDED_ERRORS)
        : run.errors,
    })
    .where(eq(backupRuns.id, run.id));
}

/** Administration → Backups: the settings and the latest snapshot. */
export async function backupStatus(env: Env) {
  const [latest] = await createDb(env.DB)
    .select()
    .from(backupRuns)
    .orderBy(desc(backupRuns.id))
    .limit(1);

  const settings = workspaceConfig().backups ?? null;

  return {
    enabled: Boolean(env.BACKUP_STORAGE && settings),
    keepDays: settings?.keepDays ?? null,
    keepWeeks: settings?.keepWeeks ?? null,
    latest: latest
      ? {
          id: latest.id,
          status: latest.status,
          startedAt: latest.startedAt.getTime(),
          finishedAt: latest.finishedAt?.getTime() ?? null,
          module: latest.module,
          itemCount: latest.itemCount,
          newObjectCount: latest.newObjectCount,
          newObjectBytes: latest.newObjectBytes,
          errors: latest.errors,
        }
      : null,
  };
}
