/**
 * The mail module's id: its `Email()` infrastructure (its migrations are
 * recorded as `modules/email/…`, so it never changes), its server part
 * (`WorkspaceModule.name`, the key of its bootstrap data) and its part of the
 * browser app (`ClientModule.name`).
 */
export const EMAIL_MODULE = "email";

/** Where JMAP is served; `Email()` runs it, and everything under it, on the Worker. */
export const JMAP_PATH = "/jmap";

/**
 * The Durable Object and Container classes index.ts exports, by the binding
 * that names them: the generated Worker entry re-exports them, and the
 * bindings' `className`s and the test Worker's replacements name them here.
 */
export const emailClasses = {
  MAILBOX: "MailboxDO",
  OFFICE_PREVIEW_CONTAINER: "OfficePreviewContainer",
} as const;

/**
 * The roles of the module's queues: `Email()`'s consumers name them, and
 * `email()` has a handler for each (`WorkspaceModule.queues`).
 */
export const emailQueueRoles = {
  officePreviews: "office-previews",
  pushNotifications: "push-notifications",
  deliveryEvents: "delivery-events",
} as const;

export type EmailQueueRole =
  (typeof emailQueueRoles)[keyof typeof emailQueueRoles];
