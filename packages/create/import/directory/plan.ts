import { z } from "zod";

/**
 * Turning a directory (people, their aliases, groups and their members)
 * into OpenWorkspace members, mailboxes and teams. Pure: the plan is what
 * a dry run prints and what the command then carries out.
 */

const directoryUserSchema = z.object({
  email: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  suspended: z.boolean(),
  isAdmin: z.boolean(),
});

export type DirectoryUser = z.infer<typeof directoryUserSchema>;

const directoryGroupSchema = z.object({
  email: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  aliases: z.array(z.string()),
  /** Member addresses (people or other groups), or "*" for everyone in the organization. */
  members: z.array(z.string()),
  /** A Google collaborative inbox: a shared inbox rather than a mailing list. */
  sharedInbox: z.boolean(),
  /** Who may write to it, when known. */
  posting: z.enum(["anyone", "workspace", "members"]).nullable(),
});

export type DirectoryGroup = z.infer<typeof directoryGroupSchema>;

/** A directory, as read from Google or saved with --save-directory. */
export const directorySchema = z.object({
  users: z.array(directoryUserSchema),
  groups: z.array(directoryGroupSchema),
});

export type Directory = z.infer<typeof directorySchema>;

/** What the workspace already has (GET /api/admin/state, trimmed). */
export const workspaceStateSchema = z.object({
  /** `mailDomains` from alchemy.run.ts, primary first: where new addresses may go. */
  mailDomains: z.array(z.string()),
  users: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      personalEmail: z.string().nullable(),
      status: z.string(),
    })
  ),
  mailboxes: z.array(
    z.object({
      id: z.string(),
      address: z.string(),
      ownerUserId: z.string().nullable(),
      teamId: z.string().nullable(),
    })
  ),
  teams: z.array(
    z.object({ id: z.string(), slug: z.string(), name: z.string() })
  ),
});

export type WorkspaceState = z.infer<typeof workspaceStateSchema>;

export type PlanOptions = {
  includeSuspended: boolean;
  /** Groups that are not collaborative inboxes become mailing lists (default) or shared inboxes. */
  groupDelivery: "list" | "inbox";
};

export type Action =
  | { kind: "invite"; name: string; email: string }
  | { kind: "alias"; ownerEmail: string; address: string; displayName: string }
  | {
      kind: "team";
      slug: string;
      name: string;
      description: string | null;
      everyone: boolean;
      memberEmails: string[];
    }
  | {
      kind: "team-mailbox";
      teamSlug: string;
      address: string;
      displayName: string;
      delivery: "list" | "inbox";
      listPosting: "anyone" | "workspace" | "members";
    };

export type Plan = {
  actions: Action[];
  /** Already in the workspace, left as they are. */
  existing: string[];
  skipped: { what: string; reason: string }[];
  /** Directory administrators, to make administrators by hand (that needs admin.access). */
  administrators: string[];
};

const normalize = (address: string) => address.trim().toLowerCase();
const domainOf = (address: string) => normalize(address).split("@")[1] ?? "";
const localPart = (address: string) => normalize(address).split("@")[0] ?? "";

/** A team handle from a group address: lowercase letters, digits and single dashes. */
export function teamSlug(email: string) {
  const slug = localPart(email)
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 64)
    .replace(/-+$/u, "");

  return slug.length >= 2 ? slug : `team-${slug || "x"}`;
}

/** Names must be 2–80 characters. */
function displayName(name: string, fallback: string) {
  const trimmed = name.trim().slice(0, 80);

  return trimmed.length >= 2
    ? trimmed
    : localPart(fallback).slice(0, 80).padEnd(2, "-");
}

/** A group's members with nested groups flattened: everyone in the organization, or these people. */
type GroupMembers = { everyone: boolean; people: Set<string> };

export function planDirectory(
  directory: Directory,
  state: WorkspaceState,
  options: PlanOptions
): Plan {
  const domains = new Set(state.mailDomains.map((domain) => normalize(domain)));

  const takenAddresses = new Set(
    state.mailboxes.map((mailbox) => normalize(mailbox.address))
  );

  const knownPeople = new Set(
    state.users.flatMap((user) =>
      user.personalEmail ? [normalize(user.personalEmail)] : []
    )
  );

  const takenSlugs = new Set(state.teams.map((team) => team.slug));

  const plan: Plan = {
    actions: [],
    existing: [],
    skipped: [],
    administrators: [],
  };

  const inWorkspace = (address: string) => domains.has(domainOf(address));

  const claim = (address: string) => {
    const key = normalize(address);

    if (takenAddresses.has(key)) return false;
    takenAddresses.add(key);

    return true;
  };

  // People first: teams name them as members.
  const people = new Set<string>(knownPeople);

  for (const user of directory.users) {
    const email = normalize(user.email);

    if (user.suspended && !options.includeSuspended) {
      plan.skipped.push({ what: email, reason: "suspended" });
      continue;
    }

    if (!inWorkspace(email)) {
      plan.skipped.push({
        what: email,
        reason: `${domainOf(email)} is not one of the workspace's mail domains`,
      });
      continue;
    }

    if (knownPeople.has(email)) {
      plan.existing.push(email);
    } else if (claim(email)) {
      plan.actions.push({
        kind: "invite",
        name: displayName(user.name, email),
        email,
      });
    } else {
      plan.skipped.push({
        what: email,
        reason: "the address is already a mailbox",
      });
      continue;
    }

    people.add(email);

    if (user.isAdmin) plan.administrators.push(email);

    for (const alias of user.aliases.map(normalize)) {
      if (!inWorkspace(alias)) {
        plan.skipped.push({
          what: alias,
          reason: `alias of ${email} in another domain`,
        });
      } else if (claim(alias)) {
        plan.actions.push({
          kind: "alias",
          ownerEmail: email,
          address: alias,
          displayName: displayName(user.name, email),
        });
      } else {
        plan.existing.push(alias);
      }
    }
  }

  // Group members, nested groups flattened.
  const groupsByEmail = new Map(
    directory.groups.map((group) => [normalize(group.email), group])
  );

  const membersOf = (
    group: DirectoryGroup,
    seen = new Set<string>()
  ): GroupMembers => {
    const result: GroupMembers = { everyone: false, people: new Set<string>() };
    seen.add(normalize(group.email));

    for (const member of group.members.map(normalize)) {
      if (member === "*") result.everyone = true;
      const nested = groupsByEmail.get(member);

      if (nested && !seen.has(member)) {
        const inner = membersOf(nested, seen);
        result.everyone ||= inner.everyone;

        for (const person of inner.people) result.people.add(person);
      } else if (people.has(member)) {
        result.people.add(member);
      }
    }

    return result;
  };

  for (const group of directory.groups) {
    const email = normalize(group.email);
    const addresses = [email, ...group.aliases.map(normalize)];
    const slug = teamSlug(email);
    const { everyone, people: members } = membersOf(group);

    const outside = group.members
      .map(normalize)
      .filter(
        (member) =>
          member !== "*" && !groupsByEmail.has(member) && !people.has(member)
      );

    if (outside.length) {
      plan.skipped.push({
        what: `${email} members`,
        reason: `not people here: ${outside.join(", ")}`,
      });
    }

    if (takenSlugs.has(slug)) {
      plan.existing.push(`team ${slug}`);
    } else {
      takenSlugs.add(slug);
      plan.actions.push({
        kind: "team",
        slug,
        name: displayName(group.name, email),
        description: group.description?.slice(0, 240) || null,
        everyone,
        memberEmails: everyone ? [] : [...members],
      });
    }

    const delivery = group.sharedInbox ? "inbox" : options.groupDelivery;

    for (const address of addresses) {
      if (!inWorkspace(address)) {
        plan.skipped.push({
          what: address,
          reason: `${domainOf(address)} is not one of the workspace's mail domains`,
        });
      } else if (claim(address)) {
        plan.actions.push({
          kind: "team-mailbox",
          teamSlug: slug,
          address,
          displayName: displayName(group.name, email),
          delivery,
          listPosting: group.posting ?? "workspace",
        });
      } else {
        plan.existing.push(address);
      }
    }
  }

  return plan;
}

/** The plan as lines for a terminal. */
export function describePlan(plan: Plan) {
  const lines: string[] = [];

  for (const action of plan.actions) {
    switch (action.kind) {
      case "invite": {
        lines.push(
          `invite   ${action.name} <${action.email}> (with a personal mailbox)`
        );
        break;
      }

      case "alias": {
        lines.push(`mailbox  ${action.address} for ${action.ownerEmail}`);
        break;
      }

      case "team": {
        lines.push(
          `team     ${action.name} (${action.slug}): ${action.everyone ? "everyone" : `${action.memberEmails.length} members`}`
        );
        break;
      }

      case "team-mailbox": {
        lines.push(
          `mailbox  ${action.address} for team ${action.teamSlug}, ${action.delivery === "list" ? `mailing list (${action.listPosting} may post)` : "shared inbox"}`
        );
        break;
      }

      default: {
        const unexpected: never = action;
        throw new Error(`Unknown plan action ${JSON.stringify(unexpected)}`);
      }
    }
  }

  for (const what of plan.existing) lines.push(`exists   ${what}`);

  for (const { what, reason } of plan.skipped) {
    lines.push(`skip     ${what}: ${reason}`);
  }

  if (plan.administrators.length) {
    lines.push(
      `note     administrators in the directory, to promote by hand: ${plan.administrators.join(", ")}`
    );
  }

  return lines;
}
