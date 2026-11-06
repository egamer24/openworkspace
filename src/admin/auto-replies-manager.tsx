import { ChevronDown, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  autoReplyStatusLabel,
  MailboxAutoReply,
  useAutoReply,
} from "@/settings/auto-replies-page";

type AdminMailbox = {
  id: string;
  address: string;
  displayName: string;
  kind: "personal" | "shared";
};

// ponytail: one status request per mailbox row; add a batched admin status
// endpoint if installs grow to hundreds of mailboxes.
function AutoReplyRow({ mailbox }: { mailbox: AdminMailbox }) {
  const [open, setOpen] = useState(false);
  const query = useAutoReply(mailbox.id);
  const status = query.data?.status;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent/45"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{mailbox.address}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {mailbox.displayName} · {mailbox.kind}
          </span>
        </span>
        {query.isLoading ? (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        ) : query.data ? (
          <Badge variant={status === "active" ? "default" : "outline"}>
            {autoReplyStatusLabel(query.data)}
          </Badge>
        ) : (
          <Badge variant="outline">Unavailable</Badge>
        )}
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="border-t border-border/70 bg-surface-sunken/30 px-4 pt-4">
          <MailboxAutoReply mailbox={mailbox} showAddress={false} />
        </div>
      ) : null}
    </div>
  );
}

/** Lets administrators see and change every mailbox's auto-reply. */
export function AutoRepliesManager({
  mailboxes,
  loading,
}: {
  mailboxes: AdminMailbox[] | undefined;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" /> Loading mailboxes…
      </div>
    );
  }
  if (!mailboxes?.length) {
    return <p className="py-6 text-sm text-muted-foreground">No mailboxes yet.</p>;
  }
  return (
    <div className="max-w-3xl divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-surface">
      {mailboxes.map((mailbox) => <AutoReplyRow key={mailbox.id} mailbox={mailbox} />)}
    </div>
  );
}
