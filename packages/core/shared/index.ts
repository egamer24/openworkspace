/**
 * `@open-workspace/core/shared`: types and helpers a module uses on both
 * sides, in its Worker code and in the browser app. Nothing here touches
 * the Worker's runtime or the DOM.
 */
export type {
  PermissionDefinition,
  WorkspacePermission,
  ListPostingPolicy,
  MailboxDelivery,
} from "./workspace";

export { hasWorkspacePermission, workspaceIconPath } from "./workspace";

export type { WebhookEventDeclaration } from "./webhooks";

export {
  isValidExternalEmailAddress,
  normalizeExternalEmailAddress,
} from "./email-address";

export { avatarSrc } from "./avatar";

export { D1_BOOKMARK_HEADER } from "./d1-bookmark";

export { coreQueueRoles } from "./queues";

export { InvariantError, invariant, required } from "./invariant";
