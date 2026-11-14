import { preloadable } from "@open-workspace/core/ui";
import type { ClientModule } from "@open-workspace/core/ui";
import {
  Archive,
  Bell,
  Mail,
  MonitorSmartphone,
  ShieldBan,
} from "lucide-react";
import { lazy } from "react";

import { MAIL_ROUTE } from "../shared/mail-path";
import { EMAIL_MODULE } from "../shared/module";
import {
  MANAGE_BLOCKED_SENDERS,
  MANAGE_MAIL_ARCHIVE,
} from "../shared/permissions";
import { emailWebhookEvents } from "../shared/webhooks";
import { prefetchMail } from "./mail/mail-prefetch";
import { loadSanitizer } from "./mail/mail-queries";
import { seedMail } from "./mail/mail-seed";

import "./mail/mail-layout.css";

/** Mail's part of the browser app; `Email()` in alchemy/index.ts points the build here. */

const mailboxRoute = preloadable(() =>
  import("./mail/mailbox-route").then((module) => module.MailboxRoute)
);

const mailBackground = preloadable(() =>
  import("./mail/mail-background").then((module) => module.MailBackground)
);

const MailboxRoute = mailboxRoute.Component;

const mail: ClientModule = {
  name: EMAIL_MODULE,
  home: { label: "mail", Component: MailboxRoute },
  app: { label: "Mail", Icon: Mail, path: "/" },
  routes: [{ path: MAIL_ROUTE, Component: MailboxRoute }],
  settings: [
    {
      id: "notifications",
      label: "Notifications",
      description: "New mail alerts for this device and your mailboxes.",
      Icon: Bell,
      Component: lazy(() =>
        import("./settings/notifications-page").then((module) => ({
          default: module.NotificationsSettings,
        }))
      ),
    },
    {
      id: "mail-apps",
      label: "Mail apps",
      description: "Connect a JMAP mail app with your account.",
      Icon: MonitorSmartphone,
      Component: lazy(() =>
        import("./settings/mail-apps-page").then((module) => ({
          default: module.MailAppsSettings,
        }))
      ),
    },
  ],
  admin: [
    {
      id: "blocked-senders",
      label: "Blocked senders",
      Icon: ShieldBan,
      permission: MANAGE_BLOCKED_SENDERS,
      title: "Blocked senders",
      description:
        "Addresses and domains blocked for every mailbox in the workspace.",
      Component: lazy(() =>
        import("./admin/blocked-senders").then((module) => ({
          default: module.BlockedSenders,
        }))
      ),
    },
    {
      id: "mail-archive",
      label: "Mail archive",
      Icon: Archive,
      permission: MANAGE_MAIL_ARCHIVE,
      title: "Mail archive",
      description:
        "A write-once copy of every message the workspace receives and sends.",
      Component: lazy(() =>
        import("./admin/mail-archive").then((module) => ({
          default: module.MailArchive,
        }))
      ),
    },
  ],
  webhookEvents: emailWebhookEvents,
  background: mailBackground.Component,
  preload: async () => {
    // Message bodies need the sanitizer (DOMPurify); the screen need not wait for it.
    loadSanitizer().catch(() => undefined);

    await Promise.all([mailboxRoute.preload(), mailBackground.preload()]);
  },
  seed: seedMail,
  prefetch: prefetchMail,
  afterSignIn: async () => {
    const { syncCurrentPushSubscription } =
      await import("./pwa/push-subscription");

    await syncCurrentPushSubscription();
  },
  beforeSignOut: async () => {
    const { removePushSubscriptionForSignOut } =
      await import("./pwa/push-subscription");

    await removePushSubscriptionForSignOut();
  },
};

export default mail;
