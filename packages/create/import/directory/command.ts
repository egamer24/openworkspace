import { readFileSync, writeFileSync } from "node:fs";

import { z } from "zod";

import { parseCliArgs } from "../args.ts";
import { commonOptions, connect, UsageError } from "../cli.ts";
import type { CliDeps } from "../cli.ts";
import { toCsv } from "../csv.ts";
import { openInBrowser } from "../oauth.ts";
import { DIRECTORY_SCOPES } from "../protocol.ts";
import type { Workspace } from "../workspace.ts";
import { googleAccessToken, readGoogleDirectory } from "./google.ts";
import {
  describePlan,
  directorySchema,
  planDirectory,
  workspaceStateSchema,
} from "./plan.ts";
import type { Action, Directory, Plan } from "./plan.ts";

const HELP = `bunx @open-workspace/create import people --google-credentials <file.json> [--admin admin@acme.com] --workspace https://mail.acme.com

Reads users, aliases and groups from Google Workspace (Admin SDK Directory API)
and creates members with personal mailboxes (aliases as more mailboxes), and
teams with their group addresses as mailing lists or shared inboxes. Writes
each new member's invitation link to a CSV.

  --google-credentials <file>  Your service account key (domain-wide delegation; pass --admin)
                               or your own Desktop app OAuth client (you sign in as an administrator)
  --admin <email>              The super administrator a service account acts as
  --customer <id>              The Google Workspace customer ID to read (default my_customer:
                               the administrator's own organization)
  --group-settings             Also read who may post to each group and which are collaborative inboxes
                               (needs the apps.groups.settings scope)
  --groups <list|inbox>        What groups that are not collaborative inboxes become (default list)
  --include-suspended          Also import suspended users
  --save-directory <file>      Keep what Google returned, to re-run with --from-directory
  --from-directory <file>      Use a saved directory instead of asking Google
  --invites <file.csv>         Where invitation links go (default openworkspace-invitations.csv)
  --dry-run                    Print the plan and change nothing`;

export type ApplyResult = {
  invitations: string[][];
  done: number;
  failed: { action: string; error: string }[];
};

const invitationSchema = z.object({
  accessLink: z.object({
    userId: z.string(),
    url: z.string(),
    expiresAt: z.string(),
  }),
});

const createdTeamSchema = z.object({ teamId: z.string() });

/** Ids of what the plan refers to by address or slug, filled in as earlier actions create them. */
type ApplyContext = {
  workspace: Workspace;
  userIds: Map<string, string>;
  teamIds: Map<string, string>;
  invitations: string[][];
};

async function applyAction(action: Action, context: ApplyContext) {
  const { workspace, userIds, teamIds } = context;

  switch (action.kind) {
    case "invite": {
      const { accessLink } = await workspace.json(
        "/api/admin/invitations",
        invitationSchema,
        {
          method: "POST",
          body: { name: action.name, email: action.email },
        }
      );

      userIds.set(action.email, accessLink.userId);
      context.invitations.push([
        action.name,
        action.email,
        accessLink.url,
        accessLink.expiresAt,
      ]);
      break;
    }

    case "alias": {
      const ownerUserId = userIds.get(action.ownerEmail);

      if (!ownerUserId) {
        throw new Error(`${action.ownerEmail} is not in the workspace`);
      }

      await workspace.call("/api/admin/mailboxes", {
        method: "POST",
        body: {
          address: action.address,
          displayName: action.displayName,
          ownerUserId,
          teamId: null,
        },
      });
      break;
    }

    case "team": {
      const members = action.memberEmails.flatMap((email) => {
        const userId = userIds.get(email);

        return userId ? [{ userId, canSend: true }] : [];
      });

      const { teamId } = await workspace.json(
        "/api/admin/teams",
        createdTeamSchema,
        {
          method: "POST",
          body: {
            name: action.name,
            slug: action.slug,
            description: action.description,
            everyone: action.everyone,
            members,
          },
        }
      );

      teamIds.set(action.slug, teamId);
      break;
    }

    case "team-mailbox": {
      const teamId = teamIds.get(action.teamSlug);

      if (!teamId) {
        throw new Error(`team ${action.teamSlug} is not in the workspace`);
      }

      await workspace.call("/api/admin/mailboxes", {
        method: "POST",
        body: {
          address: action.address,
          displayName: action.displayName,
          ownerUserId: null,
          teamId,
          delivery: action.delivery,
          listPosting: action.listPosting,
        },
      });
      break;
    }

    default: {
      const unexpected: never = action;
      throw new Error(`Unknown plan action ${JSON.stringify(unexpected)}`);
    }
  }
}

/** Carries a plan out through the admin API. Each action stands alone, so a failure skips only it. */
export async function applyPlan(
  workspace: Workspace,
  plan: Plan,
  log: (line: string) => void
): Promise<ApplyResult> {
  const state = await workspace.json("/api/admin/state", workspaceStateSchema);

  const context: ApplyContext = {
    workspace,
    userIds: new Map(
      state.users.flatMap((user) =>
        user.personalEmail ? [[user.personalEmail.toLowerCase(), user.id]] : []
      )
    ),
    teamIds: new Map(state.teams.map((team) => [team.slug, team.id])),
    invitations: [["name", "email", "invitation_url", "expires_at"]],
  };

  const result: ApplyResult = {
    invitations: context.invitations,
    done: 0,
    failed: [],
  };

  for (const action of plan.actions) {
    const label =
      "email" in action
        ? action.email
        : "address" in action
          ? action.address
          : action.slug;

    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the plan is ordered: aliases and teams use the ids of members invited before them, team mailboxes the ids of their teams
      await applyAction(action, context);
      result.done += 1;
      log(`done     ${action.kind} ${label}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failed.push({ action: `${action.kind} ${label}`, error: message });
      log(`failed   ${action.kind} ${label}: ${message}`);
    }
  }

  return result;
}

export async function peopleCommand(args: string[], deps: CliDeps) {
  const { values } = parseCliArgs({
    args,
    options: {
      ...commonOptions,
      "google-credentials": { type: "string" },
      admin: { type: "string" },
      customer: { type: "string" },
      "group-settings": { type: "boolean" },
      groups: { type: "string" },
      "include-suspended": { type: "boolean" },
      "save-directory": { type: "string" },
      "from-directory": { type: "string" },
      invites: { type: "string" },
    },
  });

  if (values.help) {
    console.log(HELP);

    return 0;
  }

  const log = deps.log ?? ((line: string) => console.error(line));
  const groupDelivery = values.groups ?? "list";

  if (groupDelivery !== "list" && groupDelivery !== "inbox") {
    throw new UsageError("--groups is list or inbox");
  }

  let directory: Directory;

  if (values["from-directory"]) {
    const saved = directorySchema.safeParse(
      JSON.parse(readFileSync(values["from-directory"], "utf-8"))
    );

    if (!saved.success) {
      throw new UsageError(
        `${values["from-directory"]} is not a directory saved with --save-directory: ${z.prettifyError(saved.error)}`
      );
    }

    directory = saved.data;
  } else {
    if (!values["google-credentials"]) {
      throw new UsageError("Pass --google-credentials (or --from-directory)");
    }

    const fetchImpl = (input: string, init?: RequestInit) => fetch(input, init);

    const token = await googleAccessToken({
      credentials: JSON.parse(
        readFileSync(values["google-credentials"], "utf-8")
      ),
      admin: values.admin,
      groupSettings: Boolean(values["group-settings"]),
      fetch: fetchImpl,
      openBrowser: deps.openBrowser ?? openInBrowser,
      log,
    });

    directory = await readGoogleDirectory(token, {
      customer: values.customer,
      groupSettings: Boolean(values["group-settings"]),
      fetch: fetchImpl,
    });
    log(
      `Google: ${directory.users.length} users, ${directory.groups.length} groups`
    );

    if (values["save-directory"]) {
      writeFileSync(
        values["save-directory"],
        JSON.stringify(directory, null, 2),
        { mode: 0o600 }
      );
    }
  }

  const workspace = await connect(values, DIRECTORY_SCOPES, deps);
  const state = await workspace.json("/api/admin/state", workspaceStateSchema);

  const plan = planDirectory(directory, state, {
    includeSuspended: Boolean(values["include-suspended"]),
    groupDelivery,
  });

  for (const line of describePlan(plan)) log(line);

  if (values["dry-run"]) {
    log(`Dry run: ${plan.actions.length} changes planned, none made.`);

    return 0;
  }

  const result = await applyPlan(workspace, plan, log);
  const invites = values.invites ?? "openworkspace-invitations.csv";

  if (result.invitations.length > 1) {
    writeFileSync(invites, toCsv(result.invitations), { mode: 0o600 });
    log(
      `${result.invitations.length - 1} invitation links written to ${invites}. Each works once; send each to its person (before you move MX, their old mailbox still works).`
    );
  }

  log(`${result.done} changes made, ${result.failed.length} failed.`);

  return result.failed.length ? 1 : 0;
}
