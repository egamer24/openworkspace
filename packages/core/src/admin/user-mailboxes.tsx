import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, Pencil, Plus, Star } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { api, responseJson } from "../lib/api";
import { AddressEditor } from "./address-editor";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "./admin-panel";
import { DeliveryIcon, deliveryBadge, deliveryLabel } from "./team-delivery";
import type { AdminMailbox, AdminUser } from "./types";

/**
 * A person's own addresses: mailboxes, aliases of them, and forwards. The
 * primary one is a mailbox, and where team mailing lists deliver.
 */
export function UserMailboxes({
  user,
  mailboxes,
  domains,
}: {
  user: AdminUser;
  mailboxes: AdminMailbox[];
  /** Mail domains new addresses may use, primary first. */
  domains: readonly string[];
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string>();

  const makePrimary = useMutation({
    mutationFn: async (id: string) =>
      responseJson(
        await api.api.admin.mailboxes[":id"].primary.$post({ param: { id } })
      ),
    onSuccess: async () => {
      toast.success("Primary mailbox updated");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin-state"] }),
        queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
      ]);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const owner = { kind: "person" as const, user };

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={Mail}
        title="Mailboxes"
        description="Addresses this person owns: mailboxes, aliases and forwards. Team mailing lists deliver to the primary one."
      >
        {editing === "new" ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="order-last"
            onClick={() => setEditing("new")}
          >
            <Plus /> Add
          </Button>
        )}
      </AdminPanelHeader>
      <AdminPanelBody className="space-y-4">
        <div className="divide-border/60 bg-surface-sunken/50 ring-border divide-y overflow-hidden rounded-xl ring-1">
          {mailboxes.map((mailbox) =>
            editing === mailbox.id ? (
              <AddressEditor
                key={mailbox.id}
                owner={owner}
                mailbox={mailbox}
                siblings={mailboxes}
                domains={domains}
                onDone={() => setEditing(undefined)}
              />
            ) : (
              <div
                key={mailbox.id}
                className="flex items-center gap-3 px-3.5 py-2.5"
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
                {mailbox.isPrimary ? (
                  <Badge>Primary</Badge>
                ) : mailbox.delivery === "inbox" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={makePrimary.isPending}
                    onClick={() => makePrimary.mutate(mailbox.id)}
                  >
                    <Star /> Make primary
                  </Button>
                ) : (
                  <Badge variant="info">
                    {deliveryBadge[mailbox.delivery]}
                  </Badge>
                )}
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Edit ${mailbox.address}`}
                  onClick={() => setEditing(mailbox.id)}
                >
                  <Pencil />
                </Button>
              </div>
            )
          )}
          {editing === "new" ? (
            <AddressEditor
              owner={owner}
              siblings={mailboxes}
              domains={domains}
              onDone={() => setEditing(undefined)}
            />
          ) : null}
        </div>
      </AdminPanelBody>
    </div>
  );
}
