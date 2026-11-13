import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
  Badge,
  Button,
  buttonVariants,
  Input,
  Label,
  cn,
} from "@open-workspace/core/ui";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  Clipboard,
  Inbox,
  LoaderCircle,
  MonitorSmartphone,
  TriangleAlert,
  Unplug,
  UsersRound,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

import { mailOauthScopes } from "../../shared/permissions";
import { mailboxesQuery } from "../mail/mail-queries";

/** What each mail scope is called where a person chooses it. */
const scopeNames = new Map([
  ["mail.read", "Read"],
  ["mail.send", "Send"],
  ["mail.organize", "Organize"],
]);

const sectionClass = "space-y-3 border-t border-border/70 pt-5";

function SectionTitle({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {children ? (
        <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
          {children}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Settings → Mail apps: how to connect a mail app over JMAP (RFC 8620/8621).
 * Apps sign in with OAuth in the browser; the apps a person approved are
 * listed, with a way to disconnect them, under Settings → Connected apps.
 */
export function MailAppsSettings() {
  const sessionUrl = new URL(
    "/.well-known/jmap",
    window.location.origin
  ).toString();

  const [copied, setCopied] = useState(false);
  const mailboxes = useQuery(mailboxesQuery());

  async function copySessionUrl() {
    try {
      await navigator.clipboard.writeText(sessionUrl);
      setCopied(true);
      toast.success("Session URL copied");
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Session URL could not be copied");
    }
  }

  const items = mailboxes.data?.mailboxes ?? [];

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={MonitorSmartphone}
        title="Connect a mail app"
        description="Your mail in an app that speaks JMAP."
      />
      <AdminPanelBody className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="jmap-session-url">JMAP session URL</Label>
          <div className="flex gap-2">
            <Input
              id="jmap-session-url"
              value={sessionUrl}
              readOnly
              className="font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => void copySessionUrl()}
            >
              {copied ? <Check /> : <Clipboard />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Paste it where the app asks for a JMAP server or session URL. Some
            apps find it from this site's address,{" "}
            <span className="text-foreground font-medium">
              {window.location.host}
            </span>
            , alone.
          </p>
        </div>

        <section className={sectionClass}>
          <SectionTitle title="Signing in">
            There is no password to give the app. It opens this site in your
            browser, you sign in with your passkey, and you choose what it may
            do:
          </SectionTitle>
          <ul
            className="grid gap-2 sm:grid-cols-3"
            aria-label="What an app may be given"
          >
            {mailOauthScopes.scopes.map((scope) => (
              <li
                key={scope.id}
                className="bg-surface-sunken/60 ring-border rounded-lg px-3 py-2.5 ring-1"
              >
                <p className="text-sm font-medium">
                  {scopeNames.get(scope.id) ?? scope.id}
                </p>
                <p className="text-muted-foreground mt-0.5 text-xs leading-5">
                  {scope.label}.
                </p>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs leading-relaxed">
            The app gets only what you approve, and never more than you can do
            yourself in Mail.
          </p>
        </section>

        <section className={sectionClass}>
          <SectionTitle title="Your mailboxes in the app">
            Every mailbox you can open shows up as its own account.
          </SectionTitle>
          {mailboxes.isLoading ? (
            <div className="text-muted-foreground flex items-center gap-2 py-2 text-sm">
              <LoaderCircle className="size-4 animate-spin" /> Loading
              mailboxes…
            </div>
          ) : mailboxes.isError ? (
            <p className="text-destructive text-sm">
              Could not load your mailboxes.
            </p>
          ) : (
            <ul
              className="divide-border/70 border-border/70 divide-y border-y"
              aria-label="Accounts a mail app sees"
            >
              {items.map((mailbox) => (
                <li key={mailbox.id} className="flex items-center gap-3 py-2.5">
                  <span className="bg-surface-sunken text-muted-foreground grid size-8 shrink-0 place-items-center rounded-lg">
                    {mailbox.kind === "shared" ? (
                      <UsersRound className="size-4" />
                    ) : (
                      <Inbox className="size-4" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {mailbox.address}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">
                      {mailbox.displayName}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Badge variant="outline">
                      {mailbox.kind === "shared" ? "Shared" : "Yours"}
                    </Badge>
                    {mailbox.canSend ? null : (
                      <Badge variant="outline">Read only</Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <div className="bg-warning/8 ring-warning/25 flex gap-3 rounded-lg px-3.5 py-3 ring-1">
            <TriangleAlert className="text-warning mt-0.5 size-4 shrink-0" />
            <div className="space-y-1.5 text-xs leading-relaxed">
              <p className="text-sm font-medium">
                Apple Mail, Outlook and Gmail can't connect
              </p>
              <p className="text-muted-foreground">
                They use IMAP and SMTP with a password, which this workspace
                doesn't offer. Few apps speak JMAP yet: look for one that asks
                for a JMAP session URL and signs in through your browser.
                Everywhere else, use Mail here; it installs as an app on phones
                and computers.
              </p>
            </div>
          </div>
        </section>

        <section className={sectionClass}>
          <SectionTitle title="Apps you connected">
            Every app you approve, mail apps and AI agents alike, is listed
            under Connected apps with what it may do. Disconnect one there and
            it loses access at once.
          </SectionTitle>
          <Link
            to="/settings/connected-apps"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            <Unplug /> Manage connected apps
          </Link>
        </section>
      </AdminPanelBody>
    </div>
  );
}
