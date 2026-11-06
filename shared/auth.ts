export const accessLinkKinds = ["invitation", "recovery"] as const;
export type AccessLinkKind = (typeof accessLinkKinds)[number];

/** `full` acts as the account everywhere; `send` may only list mailboxes, upload attachments, and send new mail. */
export const accountApiTokenScopes = ["full", "send"] as const;
export type AccountApiTokenScope = (typeof accountApiTokenScopes)[number];
