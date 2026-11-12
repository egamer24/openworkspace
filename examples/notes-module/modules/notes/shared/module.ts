import type {
  PermissionDefinition,
  WebhookEventDeclaration,
} from "@open-workspace/core/shared";

/**
 * The module's id, repeated by its three halves: `Notes()` (its migrations
 * are recorded as `modules/notes/…`, so it never changes), the Worker's
 * `WorkspaceModule.name` and the browser's `ClientModule.name`.
 */
export const NOTES_MODULE = "notes";

/** Where the app lives in the browser. */
export const NOTES_PATH = "/notes";

/** Lets a member see and delete everyone's notes, under Administration → Notes. */
export const MANAGE_NOTES = "manage_notes";

/** The OAuth scope that hands an app MANAGE_NOTES. */
export const MANAGE_NOTES_SCOPE = "admin.notes";

export const notesPermissions: PermissionDefinition[] = [
  {
    id: MANAGE_NOTES,
    label: "Manage notes",
    description: "See and delete every note in the workspace.",
    scope: MANAGE_NOTES_SCOPE,
  },
];

/** What an app (an MCP client) may do with the person's own notes. */
export const NOTES_READ_SCOPE = "notes.read";
export const NOTES_WRITE_SCOPE = "notes.write";

/** The scopes as the consent screen lists them, under Notes. An app that asks for nothing may read. */
export const notesOauthScopes = {
  group: "notes",
  title: "Notes",
  scopes: [
    { id: NOTES_READ_SCOPE, label: "Read your notes", byDefault: true },
    { id: NOTES_WRITE_SCOPE, label: "Write notes as you" },
  ],
};

export const NOTE_CREATED_EVENT = "note.created";

/** The webhook events the module sends, offered in the webhook editor. */
export const notesWebhookEvents = {
  [NOTE_CREATED_EVENT]: {
    label: "Note created",
    description: "When someone writes a note, with its title, text and author.",
  },
} satisfies Record<string, WebhookEventDeclaration>;

/** How a person's notes are listed, set under Settings → Notes. */
export const noteOrders = ["newest", "title"] as const;

export type NoteOrder = (typeof noteOrders)[number];

export const NOTE_TITLE_MAX = 120;
export const NOTE_BODY_MAX = 10_000;
