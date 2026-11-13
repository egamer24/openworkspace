/**
 * The roles of the queues core's Worker consumes: `OpenWorkspace`'s queue
 * consumers name them, `QUEUE_NAMES` maps each to its deployed queue, and
 * worker/workspace.ts has a handler for each.
 */
export const coreQueueRoles = {
  webhooks: "webhooks",
  identitySync: "identity-sync",
} as const;

export type CoreQueueRole =
  (typeof coreQueueRoles)[keyof typeof coreQueueRoles];
