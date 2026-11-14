import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { parseCliArgs } from "./args.ts";
import { parseCsv } from "./csv.ts";
import { mboxFiles, mboxItems, scanMbox } from "./mbox-source.ts";
import type { MboxSourceOptions } from "./mbox-source.ts";
import { OAuthSession, StaticToken } from "./oauth.ts";
import type { Fetch, TokenSource } from "./oauth.ts";
import { MAIL_IMPORT_SCOPES, placementSchema } from "./protocol.ts";
import type { ImportItem, Placement, SkippedItem } from "./protocol.ts";
import { progressLine, ResumeState, upload } from "./uploader.ts";
import type { UploadStats } from "./uploader.ts";
import { Workspace } from "./workspace.ts";

const USAGE = `Bring people and mail into an OpenWorkspace.

  bunx @open-workspace/create import mbox <file or Takeout folder>... --into <mailbox>
  bunx @open-workspace/create import imap --host <host> --user <user> --into <mailbox>
  bunx @open-workspace/create import people --google-credentials <file.json> [--admin <email>]
  bunx @open-workspace/create import backup <backups/<id> folder>

Common options:
  --workspace <url>      The workspace, e.g. https://mail.acme.com (or OPENWORKSPACE_URL)
  --into <mailbox>       Target mailbox: its address or id
  --map <file.csv>       Many sources at once: rows of "source,target" (imap: "user,target[,password]")
  --concurrency <n>      Uploads in flight per mailbox (default 2)
  --state-dir <dir>      Where resume state is kept (default .openworkspace-import)
  --dry-run              Read the source and print what would be imported
  --token <token>        An access token instead of signing in (or OPENWORKSPACE_TOKEN)
  --login                Sign in again even with a stored sign-in

mbox options:
  --skip <places>        Places not to import, e.g. spam,trash
  --archived-labels <archive|folder>
                         Gmail mail with your labels but not in the Inbox: Archive
                         (default; the label is lost) or the label's folder (in the Inbox)
  --folder-priority <labels>
                         Labels to prefer as a thread's folder, comma-separated
  --placement <inbox|archive>, --folder <name>
                         For mbox files without Gmail labels (default archive)

See https://openworkspace.dev/docs/migration for every source, what maps and what does not.`;

/** What the commands need from outside; tests replace them. */
export type CliDeps = {
  fetch?: Fetch;
  openBrowser?: (url: string) => void | Promise<void>;
  credentialsPath?: string | null;
  log?: (message: string) => void;
  /** Progress lines; a terminal rewrites one line. */
  progress?: (line: string) => void;
};

export const commonOptions = {
  workspace: { type: "string" },
  into: { type: "string" },
  map: { type: "string" },
  concurrency: { type: "string" },
  "state-dir": { type: "string" },
  "dry-run": { type: "boolean" },
  token: { type: "string" },
  login: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

export type CommonValues = {
  workspace?: string;
  into?: string;
  map?: string;
  concurrency?: string;
  "state-dir"?: string;
  "dry-run"?: boolean;
  token?: string;
  login?: boolean;
};

export class UsageError extends Error {}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined || value === "") throw new UsageError(message);

  return value;
}

/** Signs in (or uses a given token) and returns the workspace's API. */
export async function connect(
  values: CommonValues,
  scopes: string[],
  deps: CliDeps
) {
  const url = required(
    values.workspace ?? process.env.OPENWORKSPACE_URL,
    "Pass --workspace https://your-workspace"
  );

  const token = values.token ?? process.env.OPENWORKSPACE_TOKEN;

  const auth: TokenSource = token
    ? new StaticToken(token)
    : await OAuthSession.login({
        workspace: url,
        scopes,
        fetch: deps.fetch,
        openBrowser: deps.openBrowser,
        credentialsPath: deps.credentialsPath,
        fresh: values.login,
        log: deps.log,
      });

  return new Workspace(url, auth, deps.fetch);
}

/** One source and the mailbox it goes into (and, for IMAP, the account's password). */
export type Job = { source: string; target: string; password?: string };

/** Source → target pairs from --map, or the one source with --into. */
export function jobs(values: CommonValues, sources: string[]): Job[] {
  if (values.map) {
    const rows = parseCsv(readFileSync(values.map, "utf-8"));

    return rows.flatMap((row, index): Job[] => {
      const [source = "", target = "", password] = row;

      // A header row ("source,target") is allowed.
      if (index === 0 && /^(source|path|user)$/iu.test(source)) return [];

      if (!source || !target) {
        throw new UsageError(
          `Row ${index + 1} of ${values.map} needs a source and a target`
        );
      }

      const job: Job = { source, target };

      if (password) job.password = password;

      return [job];
    });
  }

  const into = required(
    values.into,
    "Pass --into <mailbox address or id>, or --map"
  );

  if (!sources.length) throw new UsageError("Name the source to import");

  return [{ source: sources.join("\u0000"), target: into }];
}

function progressPrinter(deps: CliDeps) {
  if (deps.progress) return deps.progress;

  if (process.stderr.isTTY) {
    return (line: string) => process.stderr.write(`\r\u001B[2K${line}`);
  }

  let last = 0;

  return (line: string) => {
    if (Date.now() - last < 5000) return;
    last = Date.now();
    console.error(line);
  };
}

/** Uploads one source's items into one mailbox and reports the outcome. */
export async function runJob(input: {
  workspace: Workspace;
  target: string;
  label: string;
  job: string;
  items: AsyncIterable<ImportItem | SkippedItem>;
  total: number | null;
  values: CommonValues;
  deps: CliDeps;
}) {
  const log = input.deps.log ?? ((message: string) => console.error(message));
  const mailbox = await input.workspace.importTarget(input.target);

  const state = new ResumeState(
    input.values["state-dir"] ?? ".openworkspace-import",
    `${new URL(input.workspace.origin).host}-${mailbox.id}-${input.job}`
  );

  const print = progressPrinter(input.deps);
  const label = `${input.label} → ${mailbox.address}`;

  const stats: UploadStats = await upload({
    workspace: input.workspace,
    mailboxId: mailbox.id,
    items: input.items,
    state,
    concurrency: Math.max(1, Number(input.values.concurrency ?? 2) || 2),
    total: input.total,
    onProgress: (current) => print(progressLine(label, current)),
  });

  if (process.stderr.isTTY && !input.deps.progress) process.stderr.write("\n");
  log(progressLine(label, stats));

  if (stats.failed) {
    log(
      `  ${stats.failed} failed; see ${state.failuresPath}. Run the same command again to retry them.`
    );
  }

  if (stats.folderSkipped) {
    log(
      `  ${stats.folderSkipped} messages kept no folder (a mailbox has at most 100, and system folder names are taken).`
    );
  }

  return stats;
}

/** Tallies what a dry run would import. */
export async function describeItems(
  items: AsyncIterable<ImportItem | SkippedItem>,
  log: (message: string) => void,
  label: string
) {
  const places = new Map<string, number>();
  const folders = new Map<string, number>();
  const skipped = new Map<string, number>();
  let unread = 0;
  let count = 0;

  for await (const item of items) {
    count += 1;

    if ("skipped" in item) {
      skipped.set(item.skipped, (skipped.get(item.skipped) ?? 0) + 1);
      continue;
    }

    places.set(item.placement, (places.get(item.placement) ?? 0) + 1);

    if (item.folder) {
      folders.set(item.folder, (folders.get(item.folder) ?? 0) + 1);
    }

    if (!item.seen) unread += 1;
  }

  const list = (map: Map<string, number>) =>
    [...map].map(([name, n]) => `${name} ${n}`).join(", ") || "none";

  log(`${label}: ${count} messages`);
  log(`  places: ${list(places)}`);
  log(`  folders: ${list(folders)}`);
  log(`  unread: ${unread}`);
  log(`  skipped: ${list(skipped)}`);

  return { count, places, folders, skipped, unread };
}

/** --skip: comma-separated places. */
export function placementList(value: string | undefined) {
  const list = new Set<Placement>();

  for (const name of (value ?? "").split(",")) {
    const item = name.trim().toLowerCase();

    if (!item) continue;
    const place = placementSchema.safeParse(item);

    if (!place.success) throw new UsageError(`Unknown place: ${item}`);
    list.add(place.data);
  }

  return list;
}

export async function mboxCommand(args: string[], deps: CliDeps) {
  const { values, positionals } = parseCliArgs({
    args,
    allowPositionals: true,
    options: {
      ...commonOptions,
      skip: { type: "string" },
      "archived-labels": { type: "string" },
      "folder-priority": { type: "string" },
      placement: { type: "string" },
      folder: { type: "string" },
    },
  });

  if (values.help) {
    console.log(USAGE);

    return 0;
  }

  const archivedLabels = values["archived-labels"] ?? "archive";

  if (archivedLabels !== "archive" && archivedLabels !== "folder") {
    throw new UsageError("--archived-labels is archive or folder");
  }

  const parsedPlacement = placementSchema.safeParse(
    values.placement ?? "archive"
  );

  if (!parsedPlacement.success) {
    throw new UsageError(`Unknown --placement: ${values.placement}`);
  }

  const placement = parsedPlacement.data;

  const options: MboxSourceOptions = {
    archivedLabels,
    folderPriority: (values["folder-priority"] ?? "")
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean),
    skip: placementList(values.skip),
    placement,
    folder: values.folder ?? null,
  };

  const log = deps.log ?? ((message: string) => console.error(message));
  const pairs = jobs(values, positionals);

  const workspace = values["dry-run"]
    ? null
    : await connect(values, MAIL_IMPORT_SCOPES, deps);

  const results: UploadStats[] = [];

  const mboxJob = async ({ source, target }: Job) => {
    const files = mboxFiles(source.split("\u0000"));

    if (!files.length) throw new UsageError(`No mbox files in ${source}`);
    log(
      `Reading ${files.length === 1 ? files[0] : `${files.length} mbox files`}…`
    );
    const scan = await scanMbox(files, options);
    const [only] = files;

    const label =
      files.length === 1 && only
        ? basename(only)
        : `${files.length} mbox files`;

    if (!workspace) {
      await describeItems(
        mboxItems(files, options, scan.threads),
        log,
        `${label} → ${target}`
      );

      return;
    }

    results.push(
      await runJob({
        workspace,
        target,
        label,
        job: `mbox-${new Bun.CryptoHasher("sha256").update(files.join("\n")).digest("hex").slice(0, 12)}`,
        items: mboxItems(files, options, scan.threads),
        total: scan.count,
        values,
        deps,
      })
    );
  };

  for (const job of pairs) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one mailbox at a time: each job reports on the one progress line, and a failure stops the jobs after it
    await mboxJob(job);
  }

  return results.some((stats) => stats.failed) ? 1 : 0;
}

type Command = (args: string[], deps: CliDeps) => Promise<number>;

/** Each source's command; the IMAP and directory ones load their dependencies only when used. */
const commands = new Map<string, () => Promise<Command>>([
  ["mbox", () => Promise.resolve(mboxCommand)],
  ["takeout", () => Promise.resolve(mboxCommand)],
  [
    "imap",
    () => import("./imap-command.ts").then((module) => module.imapCommand),
  ],
  [
    "backup",
    () => import("./backup-source.ts").then((module) => module.backupCommand),
  ],
  [
    "people",
    () =>
      import("./directory/command.ts").then((module) => module.peopleCommand),
  ],
]);

export async function main(args: string[], deps: CliDeps = {}) {
  const [name, ...rest] = args;

  if (!name || name === "--help" || name === "-h" || name === "help") {
    console.log(USAGE);

    return name ? 0 : 1;
  }

  const command = commands.get(name);

  if (!command) {
    console.error(`Unknown import source: ${name}\n\n${USAGE}`);

    return 1;
  }

  try {
    return await (
      await command()
    )(rest, deps);
  } catch (error) {
    if (
      error instanceof UsageError ||
      (error instanceof Error &&
        error.name === "TypeError" &&
        /option|argument/iu.test(error.message))
    ) {
      console.error(`${error.message}\n\nRun with --help for usage.`);

      return 1;
    }

    console.error(error instanceof Error ? error.message : error);

    return 1;
  }
}
