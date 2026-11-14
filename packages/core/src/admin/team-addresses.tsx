import { Plus } from "lucide-react";
import { useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { AddressEditor } from "./address-editor";
import { DeliveryIcon, deliveryBadge, deliveryLabel } from "./team-delivery";
import type { AdminMailbox, AdminTeam } from "./types";

/** A team's addresses: shared inboxes, mailing lists, aliases and forwards. */
export function TeamAddresses({
  team,
  mailboxes,
  domains,
}: {
  team: AdminTeam;
  mailboxes: AdminMailbox[];
  /** Mail domains new addresses may use, primary first. */
  domains: readonly string[];
}) {
  const [editing, setEditing] = useState<string>();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-foreground/85 text-[0.8125rem] font-semibold">
          Addresses
        </p>
        {editing === "new" ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setEditing("new")}
          >
            <Plus /> Add address
          </Button>
        )}
      </div>
      <div className="divide-border/60 bg-surface-sunken/50 ring-border divide-y overflow-hidden rounded-xl ring-1">
        {mailboxes.map((mailbox) =>
          editing === mailbox.id ? (
            <AddressEditor
              key={mailbox.id}
              owner={{ kind: "team", team }}
              mailbox={mailbox}
              siblings={mailboxes}
              domains={domains}
              onDone={() => setEditing(undefined)}
            />
          ) : (
            <button
              key={mailbox.id}
              type="button"
              className="hover:bg-accent/40 flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors"
              onClick={() => setEditing(mailbox.id)}
            >
              <DeliveryIcon delivery={mailbox.delivery} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.8125rem] font-medium">
                  {mailbox.address}
                </span>
                <span className="text-muted-foreground block truncate text-xs">
                  {deliveryLabel(mailbox, mailboxes)}
                </span>
              </span>
              <Badge
                variant={mailbox.delivery === "inbox" ? "outline" : "info"}
              >
                {deliveryBadge[mailbox.delivery]}
              </Badge>
            </button>
          )
        )}
        {editing === "new" ? (
          <AddressEditor
            owner={{ kind: "team", team }}
            siblings={mailboxes}
            domains={domains}
            onDone={() => setEditing(undefined)}
          />
        ) : null}
        {mailboxes.length === 0 && editing !== "new" ? (
          <p className="text-muted-foreground px-3.5 py-4 text-center text-xs">
            No addresses yet. Add a shared inbox, a mailing list, an alias or a
            forward.
          </p>
        ) : null}
      </div>
    </div>
  );
}
