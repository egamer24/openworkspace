import type {
  AppEnv,
  QueueConsumer,
  WorkspaceModule,
} from "@open-workspace/core/module";
import { Hono } from "hono";

import { EMAIL_MODULE, emailQueueRoles } from "../shared/module";
import type { EmailQueueRole } from "../shared/module";
import { emailPermissions, mailOauthScopes } from "../shared/permissions";
import { EMAIL_WEBHOOK_SOURCE, emailWebhookEvents } from "../shared/webhooks";
import { blockedSenderAdminRoutes } from "./admin/blocked-sender-routes";
import { mailBackup } from "./backups/mail-backup";
import { jmapRoutes } from "./jmap/routes";
import { runArchiveTick } from "./mail/archive";
import { mailArchiveRoutes } from "./mail/archive-routes";
import { mailBootstrap } from "./mail/bootstrap";
import { consumeDeliveryEvents } from "./mail/delivery-events";
import { demoRoutes } from "./mail/demo-routes";
import { mailDownloadRoutes } from "./mail/downloads";
import { mailImportRoutes } from "./mail/import-routes";
import { deleteMailboxStorage } from "./mail/mailbox-deletion";
import { consumeOfficePreviews } from "./mail/office-preview-queue";
import {
  consumePushNotifications,
  deleteSessionPushSubscriptions,
  deleteUserPushSubscriptions,
  pushNotificationRoutes,
} from "./mail/push-notifications";
import { receiveEmail } from "./mail/receive";
import { mailRemoteRoutes } from "./mail/remote-routes";
import { mailRoutes } from "./mail/routes";
import { emailWebhookData } from "./mail/webhook-source";
import { seedEmailDemo } from "./mailbox/demo-seed";

/** Routes the browser and MCP use under /api. */
export const mailAccountApi = new Hono<AppEnv>()
  // Ahead of mailRoutes, whose session check it does without (it answers
  // first, so that middleware never runs for it).
  .route("/mail/remote", mailRemoteRoutes)
  .route("/mail/import", mailImportRoutes)
  .route("/mail/archive", mailArchiveRoutes)
  .route("/mail", mailRoutes)
  .route("/admin", blockedSenderAdminRoutes);

const mailPublicRoutes = new Hono<AppEnv>()
  .route("/", jmapRoutes)
  .route("/api/downloads", mailDownloadRoutes)
  .route("/api/demo", demoRoutes)
  .route("/api/notifications", pushNotificationRoutes);

/** The routes this module adds, for the browser's typed client. */
export const mailBrowserApi = new Hono<AppEnv>()
  .route("/api", mailAccountApi)
  .route("/", mailPublicRoutes);

export type MailAppType = typeof mailBrowserApi;

/**
 * Team mail: personal and shared inboxes, mailing lists, previews, safety,
 * and push. `Email()` in alchemy.run.ts puts it in the generated Worker
 * entry, which also exports `MailboxDO` and `OfficePreviewContainer`.
 */
export function email(): WorkspaceModule {
  return {
    name: EMAIL_MODULE,
    accountApi: mailAccountApi,
    bootstrap: mailBootstrap,
    permissions: emailPermissions,
    oauthScopes: mailOauthScopes,
    routes: mailPublicRoutes,
    email: (message, env) => receiveEmail(message, env),
    queues: {
      [emailQueueRoles.officePreviews]: (batch, env) =>
        consumeOfficePreviews(batch, env),
      [emailQueueRoles.pushNotifications]: (batch, env) =>
        consumePushNotifications(batch, env),
      [emailQueueRoles.deliveryEvents]: (batch, env) =>
        consumeDeliveryEvents(batch, env),
    } satisfies Record<EmailQueueRole, QueueConsumer>,
    // Hourly: the mail archive's retries (a no-op without its bucket).
    scheduled: (controller, env) =>
      runArchiveTick(env, new Date(controller.scheduledTime)),
    mcpTools: () =>
      import("./mcp/tools").then((tools) => tools.registerMailTools),
    webhookEvents: emailWebhookEvents,
    webhookSources: { [EMAIL_WEBHOOK_SOURCE]: emailWebhookData },
    backup: mailBackup,
    hooks: {
      mailboxDeleted: deleteMailboxStorage,
      sessionRevoked: deleteSessionPushSubscriptions,
      sessionsRevoked: deleteUserPushSubscriptions,
      seedDemo: (env) => seedEmailDemo(env),
    },
  };
}
