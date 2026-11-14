/** Something an administrator can let a member manage. */
export type PermissionDefinition = {
  /** Stable id stored with each person, e.g. "manage_people". */
  id: string;
  label: string;
  description: string;
  /**
   * The OAuth scope that lets an app (an MCP client) use this permission
   * for the person, e.g. "admin.people"; see shared/oidc.ts.
   */
  scope: string;
};

/**
 * Parts of the workspace core lets an administrator hand to a member.
 * Modules add theirs (`WorkspaceModule.permissions`). Administrators hold
 * every permission; workspace settings and administrator promotion stay
 * with administrators.
 */
export const corePermissions = [
  {
    id: "manage_people",
    scope: "admin.people",
    label: "Manage people",
    description:
      "Invite people, edit members and their mailboxes, sign them out, and create recovery links.",
  },
  {
    id: "manage_teams",
    scope: "admin.teams",
    label: "Manage teams",
    description:
      "Create teams, change who is in them, and manage their inboxes and mailing lists.",
  },
  {
    id: "manage_webhooks",
    scope: "admin.webhooks",
    label: "Manage webhooks",
    description: "Send workspace events to external systems.",
  },
  {
    id: "manage_apps",
    scope: "admin.apps",
    label: "Manage SSO apps",
    description:
      "Configure OIDC and SAML applications that sign in with this workspace.",
  },
] as const satisfies readonly PermissionDefinition[];

export type CorePermission = (typeof corePermissions)[number]["id"];

/** A core permission, or one an installed module adds (e.g. "manage_blocked_senders"). */
export type WorkspacePermission = CorePermission | (string & {});

export function hasWorkspacePermission(
  user: {
    role: "admin" | "member";
    permissions: readonly WorkspacePermission[];
  },
  permission: WorkspacePermission
) {
  return user.role === "admin" || user.permissions.includes(permission);
}

/**
 * Where an address's mail goes: its own mailbox (inbox), every team member's
 * own mailbox (list, team addresses only), another mailbox (alias), or
 * outside addresses (forward).
 */
export const mailboxDeliveries = ["inbox", "list", "alias", "forward"] as const;

/** Outside addresses one `forward` address may send each message on to. */
export const MAX_FORWARD_DESTINATIONS = 5;

export type MailboxDelivery = (typeof mailboxDeliveries)[number];

export const listPostingPolicies = ["anyone", "workspace", "members"] as const;

export type ListPostingPolicy = (typeof listPostingPolicies)[number];

export const listPostingCopy: Record<
  ListPostingPolicy,
  { label: string; description: string }
> = {
  anyone: {
    label: "Anyone",
    description: "Any sender, including people outside the workspace.",
  },
  workspace: {
    label: "Workspace",
    description: "Only verified mail from the workspace's own addresses.",
  },
  members: {
    label: "Members",
    description: "Only verified mail from people on the team.",
  },
};

/**
 * The workspace logo an administrator uploads for the screens around signing
 * in. Raster only: an SVG could carry script.
 */
export const workspaceLogo = {
  types: ["image/png", "image/jpeg", "image/webp"],
  maxBytes: 1024 * 1024,
} as const;

/** Square sizes the logo is served at, as icons (favicon, Apple touch icon, app and notification icons). */
export const workspaceIconSizes = [64, 180, 192, 512] as const;

export type WorkspaceIconSize = (typeof workspaceIconSizes)[number];

/**
 * Where a logo is served by its id, as uploaded or as a square icon of
 * `size` pixels. Every upload gets a new id, so the URL is cacheable for good.
 */
export function workspaceLogoPath(logoId: string, size?: WorkspaceIconSize) {
  return `/api/workspace-logo/${logoId}${size ? `?size=${size}` : ""}`;
}

/**
 * The current workspace icon at a size, for places that can't read the
 * session check (the page's favicon link, the service worker): it redirects
 * to the current logo's URL, or to the OpenWorkspace icon without a logo.
 */
export function workspaceIconPath(size: WorkspaceIconSize) {
  return `/api/workspace-logo/icon/${size}`;
}

/** The name an administrator gives the workspace, shown in the app's header and title. */
export const workspaceName = {
  maxLength: 60,
} as const;

type Account = { role: string; permissions: readonly string[] };

/**
 * Why `actor` may not act on `target`'s account (recovery and access links,
 * status, profile, sessions, teams, personal mailboxes), or null if they
 * may. Administrators may act on anyone; anyone else only on members whose
 * permissions they hold themselves, so a delegate never reaches an account
 * more powerful than their own. The server passes effective permissions.
 */
export function userTargetRefusalReason(
  actor: Account,
  target: Account
): "administrator" | "permissions" | null {
  if (actor.role === "admin") return null;

  if (target.role === "admin") return "administrator";

  return target.permissions.every((permission) =>
    actor.permissions.includes(permission)
  )
    ? null
    : "permissions";
}
