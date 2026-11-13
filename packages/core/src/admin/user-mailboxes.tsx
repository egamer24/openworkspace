import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Mail, Plus, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  DomainAddressInput,
  useDomainAddress,
} from "../components/domain-address-input";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { useConfirm } from "../hooks/use-confirm";
import { api, responseJson } from "../lib/api";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "./admin-panel";
import type { AdminMailbox, AdminUser } from "./types";

/** A person's own addresses. The primary one is where team mailing lists deliver. */
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
  const [adding, setAdding] = useState(false);

  const address = useDomainAddress(domains);

  const [displayName, setDisplayName] = useState(user.name);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin-state"] }),
      queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
    ]);
  }

  const onError = (error: Error) => toast.error(error.message);

  const create = useMutation({
    mutationFn: async (value: string) =>
      responseJson(
        await api.api.admin.mailboxes.$post({
          json: {
            address: value,
            displayName,
            ownerUserId: user.id,
            teamId: null,
            delivery: "inbox",
            listPosting: "workspace",
          },
        })
      ),
    onSuccess: async () => {
      toast.success("Mailbox added");
      setAdding(false);
      address.reset();
      await refresh();
    },
    onError,
  });

  const makePrimary = useMutation({
    mutationFn: async (id: string) =>
      responseJson(
        await api.api.admin.mailboxes[":id"].primary.$post({ param: { id } })
      ),
    onSuccess: async () => {
      toast.success("Primary mailbox updated");
      await refresh();
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: async (id: string) =>
      responseJson(
        await api.api.admin.mailboxes[":id"].$delete({ param: { id } })
      ),
    onSuccess: async () => {
      toast.success("Mailbox deleted");
      await refresh();
    },
    onError,
  });

  const pending = makePrimary.isPending || remove.isPending;
  const { confirm, dialog: confirmDialog } = useConfirm();

  return (
    <div className={adminPanelClass}>
      {confirmDialog}
      <AdminPanelHeader
        Icon={Mail}
        title="Mailboxes"
        description="Addresses this person owns. Team mailing lists deliver to the primary one."
      >
        {adding ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="order-last"
            onClick={() => setAdding(true)}
          >
            <Plus /> Add
          </Button>
        )}
      </AdminPanelHeader>
      <AdminPanelBody className="space-y-4">
        <ul className="divide-border/60 bg-surface-sunken/50 ring-border divide-y overflow-hidden rounded-xl ring-1">
          {mailboxes.map((mailbox) => (
            <li
              key={mailbox.id}
              className="flex items-center gap-3 px-3.5 py-2.5"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.8125rem] font-medium">
                  {mailbox.address}
                </span>
                <span className="text-muted-foreground block truncate text-xs">
                  {mailbox.displayName}
                </span>
              </span>
              {mailbox.isPrimary ? (
                <Badge>Primary</Badge>
              ) : (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => makePrimary.mutate(mailbox.id)}
                  >
                    <Star /> Make primary
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    disabled={pending}
                    aria-label={`Delete ${mailbox.address}`}
                    onClick={async () => {
                      const confirmed = await confirm({
                        title: `Delete ${mailbox.address}?`,
                        description: `The address stops receiving mail, and all of its mail is deleted for ${user.name}. This cannot be undone.`,
                        action: "Delete mailbox",
                        destructive: true,
                      });

                      if (confirmed) remove.mutate(mailbox.id);
                    }}
                  >
                    <Trash2 />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
        {adding ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();

              if (address.address) create.mutate(address.address);
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={`user-mailbox-${user.id}`}>Address</Label>
                <DomainAddressInput
                  id={`user-mailbox-${user.id}`}
                  field={address}
                  placeholder="name"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`user-mailbox-name-${user.id}`}>
                  Display name
                </Label>
                <Input
                  id={`user-mailbox-name-${user.id}`}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  required
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setAdding(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={create.isPending || !address.address}
              >
                {create.isPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : null}
                Add mailbox
              </Button>
            </div>
          </form>
        ) : null}
      </AdminPanelBody>
    </div>
  );
}
