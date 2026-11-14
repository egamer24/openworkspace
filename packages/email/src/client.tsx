import { preloadable } from "@open-workspace/core/ui";
import type {
  ClientModule,
  TeamAddress,
  UserAddress,
} from "@open-workspace/core/ui";
import {
  Bell,
  Mail,
  MonitorSmartphone,
  PenLine,
  Plane,
  ShieldBan,
} from "lucide-react";
import { lazy, Suspense } from "react";

import { MAIL_ROUTE } from "../shared/mail-path";
import { EMAIL_MODULE } from "../shared/module";
import { MANAGE_BLOCKED_SENDERS } from "../shared/permissions";
import { emailWebhookEvents } from "../shared/webhooks";
import { ForwardDestinations } from "./admin/forward-destinations";
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

const TeamSignature = lazy(() =>
  import("./admin/team-signature").then((module) => ({
    default: module.TeamSignature,
  }))
);

// Core renders team address sections without a Suspense boundary of their own.
function TeamSignatureSection({ address }: { address: TeamAddress }) {
  return (
    <Suspense fallback={null}>
      <TeamSignature address={address} />
    </Suspense>
  );
}

const AddressAutoReply = lazy(() =>
  import("./admin/address-auto-reply").then((module) => ({
    default: module.AddressAutoReply,
  }))
);

function AddressAutoReplySection({
  address,
}: {
  address: TeamAddress | UserAddress;
}) {
  return (
    <Suspense fallback={null}>
      <AddressAutoReply address={address} />
    </Suspense>
  );
}

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
      id: "signature",
      label: "Signature",
      description: "Added to messages you send from your own mailboxes.",
      Icon: PenLine,
      Component: lazy(() =>
        import("./settings/signature-page").then((module) => ({
          default: module.SignatureSettings,
        }))
      ),
    },
    {
      id: "auto-reply",
      label: "Auto-reply",
      description: "Answer incoming mail automatically while you're away.",
      Icon: Plane,
      Component: lazy(() =>
        import("./settings/auto-reply-page").then((module) => ({
          default: module.AutoReplySettings,
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
  ],
  teamAddress: [
    { id: "signature", Component: TeamSignatureSection },
    { id: "auto-reply", Component: AddressAutoReplySection },
    // A forward's destinations, Confirmed or Waiting, in both address editors.
    { id: "forward-destinations", Component: ForwardDestinations },
  ],
  userAddress: [
    { id: "auto-reply", Component: AddressAutoReplySection },
    { id: "forward-destinations", Component: ForwardDestinations },
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
