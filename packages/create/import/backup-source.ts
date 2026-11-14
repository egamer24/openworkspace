import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { z } from "zod";

import { parseCliArgs } from "./args.ts";
import { commonOptions, connect, UsageError } from "./cli.ts";
import type { CliDeps } from "./cli.ts";
import { forEachConcurrent } from "./concurrency.ts";
import { ResumeState } from "./uploader.ts";
import { WorkspaceError } from "./workspace.ts";
import type { Workspace } from "./workspace.ts";

/**
 * `import backup`: a snapshot of the workspace's scheduled backups,
 * copied out of the bucket (`backups/<id>/` next to `backups/objects/`).
 * core.json goes back first (people, teams, addresses, SSO apps, webhooks,
 * branding), then each module's lines, each with the object it names
 * (`@open-workspace/core`, worker/backups/). What exists is left alone.
 */

/** The workspace takes these restores from administrators only. */
const BACKUP_SCOPES = ["admin.workspace", "offline_access"];

/** A line's object and the line: 25 MiB of mail and room for the line. */
const MAX_OBJECT_BYTES = 25 * 1024 * 1024;

const objectName = /^([0-9a-f]{64})\.[a-z0-9]+$/u;

/** One line of a module's part, ready to send, or why it can't be. */
export type BackupItem = {
  sourceId: string;
  module: string;
  folder: string;
} & ({ body: Uint8Array<ArrayBuffer> } | { skipped: string });

function sha256(bytes: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** Every .jsonl file under `dir`, sorted. */
function lineFiles(dir: string): string[] {
  return readdirSync(dir)
    .toSorted()
    .flatMap((entry) => {
      const path = join(dir, entry);

      if (statSync(path).isDirectory()) return lineFiles(path);

      return entry.endsWith(".jsonl") ? [path] : [];
    });
}

/**
 * Each module's lines in a snapshot, in order, each with its object read
 * from `../objects/` and checked against its hash.
 * @yields {BackupItem} Each line, or why it is skipped.
 */
export function* backupItems(snapshot: string): Generator<BackupItem> {
  const objects = join(snapshot, "..", "objects");
  const encoder = new TextEncoder();

  const modules = readdirSync(snapshot)
    .toSorted()
    .filter((entry) => statSync(join(snapshot, entry)).isDirectory());

  for (const module of modules) {
    const root = join(snapshot, module);

    for (const file of lineFiles(root)) {
      const folder = dirname(relative(root, file)).split(sep).join("/");
      const lines = readFileSync(file, "utf-8").split("\n");

      for (const [index, text] of lines.entries()) {
        if (!text.trim()) continue;
        const sourceId = `${module}/${relative(root, file)}:${index + 1}`;
        const base = { sourceId, module, folder };

        const name = z
          .object({ object: z.string().optional() })
          .parse(JSON.parse(text)).object;

        if (!name) {
          yield { ...base, body: encoder.encode(text) };
          continue;
        }

        const hash = objectName.exec(name)?.[1];
        const path = join(objects, name);

        if (!hash || !existsSync(path)) {
          yield { ...base, skipped: "missing" };
          continue;
        }

        if (statSync(path).size > MAX_OBJECT_BYTES) {
          yield { ...base, skipped: "too large" };
          continue;
        }

        const object = new Uint8Array(readFileSync(path));

        if (sha256(object) !== hash) {
          yield { ...base, skipped: "damaged" };
          continue;
        }

        const line = encoder.encode(`${text}\n`);
        const body = new Uint8Array(line.byteLength + object.byteLength);
        body.set(line);
        body.set(object, line.byteLength);
        yield { ...base, body };
      }
    }
  }
}

const restoreAnswer = z.object({
  status: z.enum(["restored", "exists", "skipped"]),
  reason: z.string().optional(),
});

type Tally = Record<"restored" | "exists" | "skipped" | "failed", number>;

/** Errors worth trying again: the network, rate limits, a bad moment. */
function retryable(cause: unknown) {
  return (
    !(cause instanceof WorkspaceError) ||
    cause.status === 429 ||
    cause.status >= 500
  );
}

/** Sends each line once, resuming where an earlier run stopped. */
async function restoreItems(
  workspace: Workspace,
  snapshot: string,
  state: ResumeState,
  concurrency: number,
  log: (message: string) => void
) {
  const tally: Tally = { restored: 0, exists: 0, skipped: 0, failed: 0 };
  const reasons = new Map<string, number>();

  const skip = (reason: string) => {
    tally.skipped += 1;
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  };

  const send = async (item: BackupItem & { body: Uint8Array<ArrayBuffer> }) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a retry waits for the attempt before it
        return await workspace.json(
          `/api/admin/backups/restore/${encodeURIComponent(item.module)}?folder=${encodeURIComponent(item.folder)}`,
          restoreAnswer,
          { method: "POST", raw: item.body }
        );
      } catch (error) {
        if (!retryable(error) || attempt > 5) throw error;
        // oxlint-disable-next-line eslint/no-await-in-loop -- see above
        await Bun.sleep(1000 * 2 ** (attempt - 1));
      }
    }
  };

  await forEachConcurrent(backupItems(snapshot), concurrency, async (item) => {
    if (state.has(item.sourceId)) return;

    if ("skipped" in item) {
      skip(item.skipped);

      return;
    }

    try {
      const answer = await send(item);

      if (answer.status === "skipped") skip(answer.reason ?? "skipped");
      else tally[answer.status] += 1;
      state.add(item.sourceId);
    } catch (error) {
      if (
        error instanceof WorkspaceError &&
        [401, 403].includes(error.status)
      ) {
        throw error;
      }

      tally.failed += 1;
      state.fail(
        item.sourceId,
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  log(
    `Lines: ${tally.restored} restored, ${tally.exists} already there, ${tally.skipped} skipped, ${tally.failed} failed`
  );

  for (const [reason, count] of reasons) log(`  skipped (${reason}): ${count}`);

  if (tally.failed) {
    log(
      `  See ${state.failuresPath}; run the same command again to retry them.`
    );
  }

  return tally;
}

const coreAnswer = z.object({
  restored: z.record(z.string(), z.union([z.number(), z.boolean()])),
});

export async function backupCommand(args: string[], deps: CliDeps) {
  const { values, positionals } = parseCliArgs({
    args,
    allowPositionals: true,
    options: commonOptions,
  });

  if (values.help) {
    console.log(`bunx @open-workspace/create import backup <backups/<id>>

  Restores a snapshot of the workspace's backups: people (invited again),
  teams, addresses, SSO apps, webhooks and branding that are missing, then
  each module's data, such as mail each address is missing.
  --concurrency, --state-dir, --dry-run as for mbox`);

    return 0;
  }

  const [snapshot] = positionals;

  if (!snapshot || !existsSync(join(snapshot, "core.json"))) {
    throw new UsageError("Name a snapshot folder, the one with core.json");
  }

  const log = deps.log ?? ((message: string) => console.error(message));

  if (values["dry-run"]) {
    const counts = new Map<string, number>();

    for (const item of backupItems(snapshot)) {
      const key =
        "skipped" in item
          ? `${item.module}: skipped (${item.skipped})`
          : `${item.module}/${item.folder}`;

      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    for (const [key, count] of counts) log(`${key}: ${count} lines`);

    return 0;
  }

  const workspace = await connect(values, BACKUP_SCOPES, deps);
  const core = JSON.parse(readFileSync(join(snapshot, "core.json"), "utf-8"));

  const { restored } = await workspace.json(
    "/api/admin/backups/restore",
    coreAnswer,
    {
      method: "POST",
      body: core,
    }
  );

  log(
    `Workspace: ${Object.entries(restored)
      .map(([kind, count]) => `${kind} ${String(count)}`)
      .join(", ")} restored (people are invited again)`
  );

  const state = new ResumeState(
    values["state-dir"] ?? ".openworkspace-import",
    `${new URL(workspace.origin).host}-backup-${sha256(new TextEncoder().encode(snapshot)).slice(0, 12)}`
  );

  const tally = await restoreItems(
    workspace,
    snapshot,
    state,
    Math.max(1, Number(values.concurrency ?? 2) || 2),
    log
  );

  return tally.failed ? 1 : 0;
}
