import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Inbox, LoaderCircle, Plus, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { listPostingCopy } from "../../shared/workspace";
import type {
  ListPostingPolicy,
  MailboxDelivery,
} from "../../shared/workspace";
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
import { clientModules } from "../modules";
import {
  AddressSectionsProvider,
  useAddressSections,
} from "./address-sections";
import { TeamDeliveryFields } from "./team-delivery";
import type { AdminMailbox, AdminTeam } from "./types";

/** A team's addresses: each one a shared inbox or a mailing list. */
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
              team={team}
              mailbox={mailbox}
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
              {mailbox.delivery === "list" ? (
                <Send className="text-muted-foreground size-4 shrink-0" />
              ) : (
                <Inbox className="text-muted-foreground size-4 shrink-0" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.8125rem] font-medium">
                  {mailbox.address}
                </span>
                <span className="text-muted-foreground block truncate text-xs">
                  {mailbox.delivery === "list"
                    ? `Mailing list · ${listPostingCopy[mailbox.listPosting].label} can write`
                    : `Shared inbox · ${mailbox.displayName}`}
                </span>
              </span>
              <Badge variant={mailbox.delivery === "list" ? "info" : "outline"}>
                {mailbox.delivery === "list" ? "Mailing list" : "Inbox"}
              </Badge>
            </button>
          )
        )}
        {editing === "new" ? (
          <AddressEditor
            team={team}
            domains={domains}
            onDone={() => setEditing(undefined)}
          />
        ) : null}
        {mailboxes.length === 0 && editing !== "new" ? (
          <p className="text-muted-foreground px-3.5 py-4 text-center text-xs">
            No addresses yet. Add one as a shared inbox or a mailing list.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The address an editor saves: the one it opened, or a new one. */
type SaveTarget = { mailboxId: string } | { address: string };

function AddressEditor({
  team,
  mailbox,
  domains,
  onDone,
}: {
  team: AdminTeam;
  mailbox?: AdminMailbox;
  /** Mail domains new addresses may use, primary first. */
  domains: readonly string[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();

  const address = useDomainAddress(domains);

  const [displayName, setDisplayName] = useState(
    mailbox?.displayName ?? team.name
  );

  const [delivery, setDelivery] = useState<MailboxDelivery>(
    mailbox?.delivery ?? "inbox"
  );

  const [listPosting, setListPosting] = useState<ListPostingPolicy>(
    mailbox?.listPosting ?? "workspace"
  );

  const sections = useAddressSections();
  const [sectionError, setSectionError] = useState<string | null>(null);

  // Saved as is: a new address always needs saving, a saved one only if changed.
  const addressDirty =
    !mailbox ||
    displayName !== mailbox.displayName ||
    delivery !== mailbox.delivery ||
    listPosting !== mailbox.listPosting;

  const idPrefix = `team-address-${mailbox?.id ?? "new"}`;
  const { confirm, dialog: confirmDialog } = useConfirm();

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin-state"] }),
      queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
    ]);
  }

  async function saveAddress(target: SaveTarget) {
    if ("mailboxId" in target) {
      await responseJson(
        await api.api.admin.mailboxes[":id"].$patch({
          param: { id: target.mailboxId },
          json: { displayName, delivery, listPosting },
        })
      );

      return;
    }

    await responseJson(
      await api.api.admin.mailboxes.$post({
        json: {
          address: target.address,
          displayName,
          ownerUserId: null,
          teamId: team.id,
          delivery,
          listPosting,
        },
      })
    );
  }

  // The address first, then each module section with changes; the editor
  // closes only if all of them were saved.
  const save = useMutation({
    mutationFn: async (target: SaveTarget) => {
      setSectionError(null);

      if (addressDirty) await saveAddress(target);

      try {
        await sections.save();
      } catch (error) {
        // The address may be saved already: show it, keep the editor open.
        await refresh();
        throw error;
      }
    },
    onSuccess: async () => {
      toast.success(mailbox ? "Address updated" : "Address added");
      await refresh();
      onDone();
    },
    onError: (error) => {
      setSectionError(error.message);
      toast.error(error.message);
    },
  });

  const remove = useMutation({
    mutationFn: async (mailboxId: string) =>
      responseJson(
        await api.api.admin.mailboxes[":id"].$delete({
          param: { id: mailboxId },
        })
      ),
    onSuccess: async () => {
      toast.success("Address deleted");
      await refresh();
      onDone();
    },
    onError: (error) => toast.error(error.message),
  });

  async function submit(event: {
    preventDefault(): void;
    stopPropagation(): void;
  }) {
    event.preventDefault();
    event.stopPropagation();

    const target: SaveTarget | null = mailbox
      ? { mailboxId: mailbox.id }
      : address.address
        ? { address: address.address }
        : null;

    if (!target) return;

    if (
      mailbox?.delivery === "inbox" &&
      delivery === "list" &&
      !(await confirm({
        title: `Turn ${mailbox.address} into a mailing list?`,
        description:
          "New mail goes to each member's own mailbox, and the mail already here is no longer shown.",
        action: "Make it a mailing list",
      }))
    ) {
      return;
    }

    save.mutate(target);
  }

  return (
    // A nested form would submit the team editor; this one stands alone in the DOM tree.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Enter in a field submits this group, as in a form
    <div
      role="group"
      aria-label={mailbox ? `Edit ${mailbox.address}` : "New address"}
      className="bg-surface space-y-4 px-3.5 py-4"
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          event.target instanceof HTMLInputElement &&
          !event.target.closest("[data-module-section]")
        ) {
          void submit(event);
        }
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-address`}>Address</Label>
          {mailbox ? (
            <Input
              id={`${idPrefix}-address`}
              value={mailbox.address}
              readOnly
              disabled
            />
          ) : (
            <DomainAddressInput
              id={`${idPrefix}-address`}
              field={address}
              placeholder={team.slug}
              required
            />
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-name`}>Display name</Label>
          <Input
            id={`${idPrefix}-name`}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>
      </div>
      <TeamDeliveryFields
        idPrefix={idPrefix}
        delivery={delivery}
        listPosting={listPosting}
        onDeliveryChange={(next) => {
          setDelivery(next);
          // A section's error goes with it when the delivery hides it.
          setSectionError(null);
        }}
        onListPostingChange={setListPosting}
      />
      {mailbox ? (
        <AddressSectionsProvider sections={sections}>
          {clientModules().flatMap((module) =>
            (module.teamAddress ?? []).map(({ id, Component }) => (
              // Modules save their sections themselves, so Enter there doesn't save the address.
              <div key={`${module.name}:${id}`} data-module-section>
                <Component
                  address={{
                    mailboxId: mailbox.id,
                    address: mailbox.address,
                    displayName: mailbox.displayName,
                    // The form's choice, so a section can hide at once.
                    delivery,
                    teamId: team.id,
                  }}
                />
              </div>
            ))
          )}
        </AddressSectionsProvider>
      ) : null}
      {sectionError ? (
        <p role="alert" className="text-destructive text-xs">
          {sectionError}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        {mailbox ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={remove.isPending}
            onClick={async () => {
              const confirmed = await confirm({
                title: `Delete ${mailbox.address}?`,
                description:
                  "The address stops receiving mail, and all of its mail is deleted. This cannot be undone.",
                action: "Delete address",
                destructive: true,
              });

              if (confirmed) remove.mutate(mailbox.id);
            }}
          >
            <Trash2 /> Delete
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={onDone}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={
            save.isPending ||
            displayName.trim().length < 2 ||
            (!mailbox && !address.address) ||
            (!addressDirty && !sections.dirty)
          }
          onClick={submit}
        >
          {save.isPending ? <LoaderCircle className="animate-spin" /> : null}
          {mailbox ? "Save address" : "Add address"}
        </Button>
      </div>
      {confirmDialog}
    </div>
  );
}
