import { z } from "zod";

/**
 * The workspace's import API (@open-workspace/email, worker/mail/import-routes.ts).
 * Kept here, not imported, so the CLI does not depend on the mail module.
 */

/** The largest message the workspace accepts (MAX_IMPORT_MESSAGE_BYTES). */
export const MAX_IMPORT_MESSAGE_BYTES = 25 * 1024 * 1024;

export const placementSchema = z.enum([
  "inbox",
  "archive",
  "spam",
  "trash",
  "sent",
]);

export type Placement = z.infer<typeof placementSchema>;

/** One message to import and where it goes. */
export type ImportItem = {
  /** Stable id at the source; the workspace imports each once. */
  sourceId: string;
  raw: Uint8Array<ArrayBuffer>;
  placement: Placement;
  folder?: string | null;
  seen?: boolean;
  thread?: string;
  receivedAt?: number;
  direction?: "incoming" | "outgoing";
};

/** A message the reader could not hand over (too large, unreadable). */
export type SkippedItem = { sourceId: string; skipped: string };

export const importTargetSchema = z.object({
  id: z.string(),
  address: z.string(),
  displayName: z.string(),
  kind: z.enum(["personal", "shared"]),
});

export type ImportTarget = z.infer<typeof importTargetSchema>;

/** OAuth scopes the CLI asks for: import (own mailboxes, or any), and refresh tokens. */
export const MAIL_IMPORT_SCOPES = [
  "mail.organize",
  "admin.import_mail",
  "offline_access",
];

/** For the directory import: people, teams and their mailboxes. */
export const DIRECTORY_SCOPES = [
  "people.read",
  "admin.people",
  "admin.teams",
  "offline_access",
];
