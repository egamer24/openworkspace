import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
  responseJson,
} from "@open-workspace/core/ui";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, Plane } from "lucide-react";

import { mailApi } from "../lib/mail-api";
import { MailboxAutoReply } from "./auto-reply-editor";

/** Settings → Auto-reply: the person's own mailboxes, not team inboxes. */
export function AutoReplySettings() {
  const mailboxes = useQuery({
    queryKey: ["auto-reply-mailboxes"],
    queryFn: async () =>
      responseJson(await mailApi.api.mail["auto-replies"].$get()),
  });

  const own = mailboxes.data?.mailboxes ?? [];

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={Plane}
        title="Auto-reply"
        description="Answer incoming mail automatically while you're away. Mailing lists, bounces, other auto-responders, Spam and Trash are never answered."
      />
      <AdminPanelBody className="divide-border/70 divide-y">
        {mailboxes.isPending ? (
          <div className="text-muted-foreground flex items-center gap-2 py-5 text-sm">
            <LoaderCircle className="size-4 animate-spin" /> Loading mailboxes…
          </div>
        ) : own.length > 0 ? (
          own.map((mailbox) => (
            <section key={mailbox.id} className="py-5 first:pt-0">
              <MailboxAutoReply
                mailbox={mailbox}
                uploadMailboxId={mailbox.id}
              />
            </section>
          ))
        ) : (
          <p className="text-muted-foreground py-4 text-sm">
            You have no mailbox of your own.
          </p>
        )}
      </AdminPanelBody>
    </div>
  );
}
