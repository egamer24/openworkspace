import * as p from "@clack/prompts";
import { ImapFlow } from "imapflow";

import { parseCliArgs } from "./args.ts";
import {
  commonOptions,
  connect,
  describeItems,
  jobs,
  placementList,
  runJob,
  UsageError,
} from "./cli.ts";
import type { CliDeps, Job } from "./cli.ts";
import { imapSource } from "./imap-source.ts";
import type { ImapSourceOptions } from "./imap-source.ts";
import { MAIL_IMPORT_SCOPES } from "./protocol.ts";
import { ResumeState } from "./uploader.ts";
import type { UploadStats } from "./uploader.ts";

/**
 * `import imap`: one account (--user, --into) or many (--map rows of
 * "user,target[,password]"). Authenticates with a password (an app
 * password for Gmail) or an OAuth access token (XOAUTH2).
 */
export async function imapCommand(args: string[], deps: CliDeps) {
  const { values } = parseCliArgs({
    args,
    options: {
      ...commonOptions,
      host: { type: "string" },
      port: { type: "string" },
      plain: { type: "boolean" },
      user: { type: "string" },
      password: { type: "string" },
      "password-env": { type: "string" },
      "access-token": { type: "string" },
      skip: { type: "string" },
      "archived-labels": { type: "string" },
      "folder-priority": { type: "string" },
    },
  });

  if (values.help) {
    console.log(`bunx @open-workspace/create import imap --host imap.gmail.com --user ada@acme.com --into ada@acme.com

  --host, --port (993)     The IMAP server; --plain for an unencrypted connection (local testing only)
  --user                   The account (or --map rows of "user,target[,password]")
  --password-env <VAR>     Read the password (a Gmail app password) from this variable; else you are asked
  --password <password>    The password on the command line (visible in your shell history)
  --access-token <token>   An OAuth access token instead (XOAUTH2), e.g. from your own Google Cloud client
  --skip, --archived-labels, --folder-priority, --concurrency, --state-dir, --dry-run as for mbox`);

    return 0;
  }

  const { host } = values;

  if (!host) throw new UsageError("Pass --host, e.g. imap.gmail.com");
  const port = Number(values.port ?? (values.plain ? 143 : 993));
  const archivedLabels = values["archived-labels"] ?? "archive";

  if (archivedLabels !== "archive" && archivedLabels !== "folder") {
    throw new UsageError("--archived-labels is archive or folder");
  }

  const skip = placementList(values.skip);
  const log = deps.log ?? ((message: string) => console.error(message));

  if (!values.map && (!values.user || !values.into)) {
    throw new UsageError("Pass --user and --into, or --map");
  }

  const pairs: Job[] = values.map
    ? jobs(values, [])
    : [{ source: values.user ?? "", target: values.into ?? "" }];

  const workspace = values["dry-run"]
    ? null
    : await connect(values, MAIL_IMPORT_SCOPES, deps);

  const results: UploadStats[] = [];

  const importAccount = async ({
    source: user,
    target,
    password: rowPassword,
  }: Job) => {
    const accessToken = values["access-token"];

    const auth = accessToken
      ? { user, accessToken }
      : {
          user,
          pass:
            rowPassword ||
            (values["password-env"]
              ? process.env[values["password-env"]]
              : undefined) ||
            values.password ||
            (await askPassword(user)),
        };

    const client = new ImapFlow({
      host,
      port,
      secure: !values.plain,
      auth,
      logger: false,
      // A long import outlives the server's idea of an idle session.
      disableAutoIdle: true,
    });

    await client.connect();

    try {
      const account = `${host}/${user}`;
      const job = `imap-${account}`;

      const state = workspace
        ? new ResumeState(
            values["state-dir"] ?? ".openworkspace-import",
            `${new URL(workspace.origin).host}-${(await workspace.importTarget(target)).id}-${job}`
          )
        : null;

      const options: ImapSourceOptions = {
        archivedLabels,
        folderPriority: (values["folder-priority"] ?? "")
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean),
        skip,
        account,
        done: (sourceId) => state?.has(sourceId) ?? false,
      };

      const source = await imapSource(client, options);
      log(
        `${user}: ${source.total} messages${source.gmail ? " in All Mail (Gmail)" : ""}`
      );

      if (!workspace) {
        await describeItems(source.items, log, `${user} → ${target}`);

        return;
      }

      results.push(
        await runJob({
          workspace,
          target,
          label: user,
          job,
          items: source.items,
          total: source.total,
          values,
          deps,
        })
      );
    } finally {
      await client.logout().catch(() => client.close());
    }
  };

  for (const job of pairs) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one account at a time: a password may be asked for each, and each job reports on the one progress line
    await importAccount(job);
  }

  return results.some((stats) => stats.failed) ? 1 : 0;
}

async function askPassword(user: string) {
  const value = await p.password({
    message: `IMAP password for ${user} (for Gmail, an app password)`,
  });

  if (p.isCancel(value)) throw new UsageError("No password given");

  return value;
}
