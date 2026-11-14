import type { PermissionDefinition } from "@open-workspace/core/shared";

/** Lets a member block senders and domains for every mailbox in the workspace. */
export const MANAGE_BLOCKED_SENDERS = "manage_blocked_senders";

/** The OAuth scope that hands an app MANAGE_BLOCKED_SENDERS. */
export const BLOCK_SENDERS_SCOPE = "admin.blocked_senders";

/**
 * Lets a member import existing mail into any mailbox in the workspace.
 * Without it, a person may import only into their own personal mailboxes
 * (and an app only with `mail.organize`); see worker/mail/import-routes.ts.
 */
export const IMPORT_MAIL = "import_mail";

/** The OAuth scope that hands an app IMPORT_MAIL. */
export const IMPORT_MAIL_SCOPE = "admin.import_mail";

/** Lets a member see the mail archive's state and retry its copies. */
export const MANAGE_MAIL_ARCHIVE = "manage_mail_archive";

/** The OAuth scope that hands an app MANAGE_MAIL_ARCHIVE. */
export const MAIL_ARCHIVE_SCOPE = "admin.mail_archive";

/** What the mail module lets an administrator hand to a member. */
export const emailPermissions: PermissionDefinition[] = [
  {
    id: MANAGE_BLOCKED_SENDERS,
    label: "Block senders",
    scope: BLOCK_SENDERS_SCOPE,
    description: "Block senders and domains for the whole workspace.",
  },
  {
    id: IMPORT_MAIL,
    label: "Import mail",
    scope: IMPORT_MAIL_SCOPE,
    description: "Import existing mail into any mailbox in the workspace.",
  },
  {
    id: MANAGE_MAIL_ARCHIVE,
    label: "Mail archive",
    scope: MAIL_ARCHIVE_SCOPE,
    description: "See the mail archive and retry copies that failed.",
  },
];

/**
 * What an app (an MCP client, or a mail app over JMAP) may do with the mail
 * of the mailboxes its person can open. Each only works as far as the
 * person may go themselves.
 */
export const MAIL_READ_SCOPE = "mail.read";
export const MAIL_SEND_SCOPE = "mail.send";
export const MAIL_ORGANIZE_SCOPE = "mail.organize";

export const mailScopes = [
  MAIL_READ_SCOPE,
  MAIL_SEND_SCOPE,
  MAIL_ORGANIZE_SCOPE,
] as const;

/**
 * The mail scopes as the consent screen shows them, under Mail. A
 * self-registered app that asks for nothing may read mail.
 */
export const mailOauthScopes = {
  group: "mail",
  title: "Mail",
  scopes: [
    {
      id: MAIL_READ_SCOPE,
      label: "Read the mail in the mailboxes you can open",
      byDefault: true,
    },
    {
      id: MAIL_SEND_SCOPE,
      label: "Send mail as you, from the mailboxes you may send from",
    },
    {
      id: MAIL_ORGANIZE_SCOPE,
      label:
        "Organize your mail: mark it read, move it, report spam, and manage folders and senders",
    },
  ],
};
