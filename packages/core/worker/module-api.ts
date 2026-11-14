/// <reference path="./workers-runtime.d.ts" />
/// <reference path="./bindings.d.ts" />
/**
 * `@open-workspace/core/module`: what a module's Worker code builds on. Its
 * `WorkspaceModule` contract, the session and permission middleware its
 * routes run behind, the shared D1 database, and the helpers for its HTTP
 * answers, MCP tools, webhooks and AI. Worker code only; types and helpers
 * the browser shares are in `@open-workspace/core/shared`.
 */

// The contract.
export type {
  BackupRestoreItem,
  BackupRestoreResult,
  BackupSnapshot,
  McpToolRegistrar,
  ModuleBackup,
  ModuleOauthScopes,
  QueueConsumer,
  ScopedToolRegistrar,
  WorkspaceModule,
} from "./modules";

export type { AppEnv, SessionUser } from "./env";

// Signed-in requests: sessions, OAuth scopes, and permissions.
export {
  bearerToken,
  requireAuth,
  requireAuthWith,
  requireSessionAuth,
} from "./auth/middleware";

export type { SessionCompanion } from "./auth/session";

export { oauthScope, oauthScopeAnyOf } from "./auth/oauth-scopes";

export { can, requestPermissions, requirePermission } from "./auth/permissions";

export {
  authenticateAccessToken,
  jmapProtectedResourceMetadataUrl,
  jmapResourceUri,
} from "./oidc/mcp-clients";

export { oidcIssuer } from "./oidc/keys";

// The workspace's D1 database: its client, and core's tables a module joins.
export { createDb, type Database } from "./db/client";

// What a module's statement hooks return, run in core's D1 batch.
export type { BatchStatement } from "./lib/batch";

export {
  mailboxAccess,
  mailboxes,
  oidcGrants,
  sessions,
  teamMembers,
  teamMembership,
  teams,
  users,
  webhookDeliveries,
} from "./db/schema";

export {
  mailboxAddressPredicate,
  mailboxAddressSql,
  mailboxKind,
  mailboxKindOrderSql,
} from "./db/mailboxes";

// Answers and input.
export { apiError, type ApiErrorCode } from "./lib/http";

export { zValidator } from "./lib/validator";

export {
  describeIssues,
  issuePath,
  issueProperties,
  type Issue,
} from "./lib/issues";

export { emailSchema } from "./auth/schemas";

export {
  overRateLimit,
  rateLimitedResponse,
  withinRateLimit,
} from "./lib/rate-limit";

export { timed } from "./lib/server-timing";

export {
  createId,
  emailDomain,
  normalizeEmail,
  normalizeMailboxAddress,
} from "./lib/ids";

export {
  base64UrlToBytes,
  bytesToBase64Url,
  hashToken,
  randomToken,
} from "./lib/crypto";

// MCP tools: they call the module's own routes in-process.
export { AccountApiClient, apiPath } from "./mcp/account-client";

export {
  runBinaryResourceTool,
  runResourceLinkTool,
  runTool,
  toolError,
  toolResult,
} from "./mcp/results";

export { entityIdSchema } from "./mcp/schemas";

// Webhooks.
export {
  deferWebhookTask,
  queueWebhookEvent,
  type WebhookDeliveryJob,
  type WebhookDispatchJob,
} from "./webhooks/service";

// Mail domains, as configured in `OpenWorkspace({ mailDomains })`, primary first.
export {
  configuredMailDomains,
  mailDomainAllowed,
  mailDomainRefusal,
  primaryMailDomain,
} from "./config/mail-domains";

// AI, as configured in `OpenWorkspace({ ai })`.
export { aiFeatureEnabled, aiModel, type AiModel } from "./ai/models";

export {
  aiObjectRunner,
  type AiObjectRequest,
  type AiObjectRunner,
} from "./ai/generate";
