import { Hono } from "hono";
import { accountApi } from "./account-api";
import { verifySameOrigin } from "./auth/middleware";
import { mockAuthRoutes } from "./auth/mock";
import { authRoutes } from "./auth/routes";
import { publicBookingRoutes } from "./calendar/booking-routes";
import { calendarFeedRoutes } from "./calendar/routes";
import { createDb } from "./db/client";
import { domains, mailboxes } from "./db/schema";
import { mailboxAddressPredicate } from "./db/mailboxes";
import { drivePublicRoutes } from "./drive/public-routes";
import type { AppEnv } from "./env";
import { jmapRoutes } from "./jmap/routes";
import { mailDownloadRoutes } from "./mail/downloads";
import { consumeDeliveryEvents } from "./mail/delivery-events";
import { inboundDeliveryId } from "./mail/inbound-delivery";
import { forwardInbound, resolveInboundRoute } from "./mail/inbound-routing";
import {
  consumePushNotifications,
  PUSH_NOTIFICATION_QUEUE,
  pushNotificationRoutes,
} from "./mail/push-notifications";
import { mailboxStub } from "./mailbox";
import { mcpRoutes } from "./mcp/routes";
import {
  oidcConsentRoutes,
  oidcLoginRoutes,
  oidcLogoutRoutes,
  oidcRoutes,
  wellKnownRoutes,
} from "./oidc/routes";
export { MailboxDO } from "./mailbox";
export { CalendarDO } from "./calendar";
export { OfficePreviewContainer } from "./mail/office-preview-container";
import { OFFICE_PREVIEW_QUEUE } from "../shared/office-preview";
import { consumeOfficePreviews } from "./mail/office-preview-queue";
import { normalizeMailboxAddress } from "./lib/ids";
import { consumeWebhooks } from "./webhooks/delivery";
import { WEBHOOK_QUEUE } from "./webhooks/service";
import { samlLoginRoutes, samlRoutes } from "./saml/routes";
import { runBackupTick } from "./backups/job";

const app = new Hono<AppEnv>()
  .use("/api/*", verifySameOrigin)
  .get("/api/health", (c) => c.json({ ok: true as const }))
  .route("/api/auth", authRoutes)
  .route("/api/auth/mock", mockAuthRoutes)
  .route("/api/oidc/consent", oidcConsentRoutes)
  .route("/api/oidc/login", oidcLoginRoutes)
  .route("/api/oidc/logout", oidcLogoutRoutes)
  .route("/api/saml/login", samlLoginRoutes)
  .route("/api/downloads", mailDownloadRoutes)
  .route("/api/public/booking", publicBookingRoutes)
  .route("/api", accountApi)
  .route("/api/notifications", pushNotificationRoutes)
  .route("/mcp", mcpRoutes)
  .route("/", jmapRoutes)
  .route("/d", drivePublicRoutes)
  .route("/ics", calendarFeedRoutes)
  .route("/.well-known", wellKnownRoutes)
  .route("/oauth", oidcRoutes)
  .route("/saml", samlRoutes)
  .notFound((c) =>
    c.json(
      { ok: false as const, error: { code: "NOT_FOUND", message: "Not found" } },
      404,
    ),
  )
  .onError((error, c) => {
    console.error(error);
    return c.json(
      {
        ok: false as const,
        error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
      },
      500,
    );
  });

export type AppType = typeof app;

export default {
  fetch: app.fetch,
  async email(message, env) {
    const receivedAt = Date.now();
    const recipient = normalizeMailboxAddress(message.to);
    const route = await resolveInboundRoute(env.DB, recipient);
    if (!route) {
      message.setReject(`Mailbox ${recipient} does not exist`);
      return;
    }
    const { forwarded, failed } = await forwardInbound(message, route.forwards);
    // Store when the address keeps a copy, and as a fallback when nothing was
    // forwarded so a skipped or failed forward never loses the message.
    const mailbox = route.mailboxId && (route.keepCopy || forwarded === 0)
      ? { id: route.mailboxId }
      : null;
    if (!mailbox) {
      if (forwarded > 0) return;
      // A temporary failure lets the sending server retry later.
      if (failed > 0) throw new Error(`Forwarding ${recipient} failed`);
      message.setReject(`Address ${recipient} has no forwarding destination available`);
      return;
    }

    const raw = await new Response(message.raw).arrayBuffer();
    const deliveryId = await inboundDeliveryId({
      mailboxId: mailbox.id,
      envelopeFrom: message.from,
      envelopeTo: message.to,
      raw,
    });
    const objectKey = `mailboxes/${mailbox.id}/raw/${deliveryId}.eml`;
    await mailboxStub(env, mailbox.id).enqueueInbound({
      id: deliveryId,
      mailboxId: mailbox.id,
      rawObjectKey: objectKey,
      envelopeFrom: message.from,
      envelopeTo: message.to,
      receivedAt,
    });
    await env.MAIL_STORAGE.put(
      objectKey,
      raw,
      { httpMetadata: { contentType: "message/rfc822" } },
    );
  },
  queue(batch, env) {
    if (batch.queue === OFFICE_PREVIEW_QUEUE) return consumeOfficePreviews(batch, env);
    if (batch.queue === PUSH_NOTIFICATION_QUEUE) {
      return consumePushNotifications(batch, env);
    }
    if (batch.queue === WEBHOOK_QUEUE) {
      return consumeWebhooks(batch, env);
    }
    return consumeDeliveryEvents(batch, env);
  },
  async scheduled(controller, env) {
    await runBackupTick(env, new Date(controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
