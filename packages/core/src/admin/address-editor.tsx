import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  DomainAddressInput,
  useDomainAddress,
} from "../components/domain-address-input";
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
import {
  DeliveryFields,
  deliveryChanged,
  deliveryComplete,
  deliveryForm,
  deliveryInput,
  forwardDestinations,
} from "./team-delivery";
import type { AdminMailbox, AdminTeam, AdminUser } from "./types";

/** Whose address an editor edits: a team's, or a person's. */
export type AddressOwner =
  | { kind: "team"; team: AdminTeam }
  | { kind: "person"; user: AdminUser };

/** The address an editor saves: the one it opened, or a new one. */
type SaveTarget = { mailboxId: string } | { address: string };

/**
 * One address of a team or a person: its display name, how it delivers, and
 * the modules' sections (`ClientModule.teamAddress` or `userAddress`), which
 * save with "Save address" after the address.
 */
export function AddressEditor({
  owner,
  mailbox,
  siblings,
  domains,
  onDone,
}: {
  owner: AddressOwner;
  mailbox?: AdminMailbox;
  /** The owner's other addresses, which an alias may deliver into. */
  siblings: readonly AdminMailbox[];
  /** Mail domains new addresses may use, primary first. */
  domains: readonly string[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();

  const address = useDomainAddress(domains);
  const ownerName = owner.kind === "team" ? owner.team.name : owner.user.name;

  const [displayName, setDisplayName] = useState(
    mailbox?.displayName ?? ownerName
  );

  const [form, setForm] = useState(() => deliveryForm(mailbox));

  const sections = useAddressSections();
  const [sectionError, setSectionError] = useState<string | null>(null);

  // Saved as is: a new address always needs saving, a saved one only if changed.
  const addressDirty =
    !mailbox ||
    displayName !== mailbox.displayName ||
    deliveryChanged(form, mailbox);

  const idPrefix = `${owner.kind}-address-${mailbox?.id ?? "new"}`;
  const { confirm, dialog: confirmDialog } = useConfirm();

  const aliasTargets = siblings.filter(
    (other) =>
      other.id !== mailbox?.id &&
      (other.delivery === "inbox" || other.delivery === "list")
  );

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin-state"] }),
      queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
    ]);
  }

  async function saveAddress(target: SaveTarget) {
    const delivery = deliveryInput(form);

    if ("mailboxId" in target) {
      await responseJson(
        await api.api.admin.mailboxes[":id"].$patch({
          param: { id: target.mailboxId },
          json: { displayName, ...delivery },
        })
      );

      return;
    }

    await responseJson(
      await api.api.admin.mailboxes.$post({
        json: {
          address: target.address,
          displayName,
          ownerUserId: owner.kind === "person" ? owner.user.id : null,
          teamId: owner.kind === "team" ? owner.team.id : null,
          ...delivery,
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
      form.delivery !== "inbox" &&
      !(await confirm({
        title: `Stop keeping mail at ${mailbox.address}?`,
        description:
          form.delivery === "list"
            ? "New mail goes to each member's own mailbox, and the mail already here is no longer shown."
            : "New mail goes elsewhere, and the mail already here is no longer shown.",
        action: "Change delivery",
      }))
    ) {
      return;
    }

    save.mutate(target);
  }

  const aliases = mailbox
    ? siblings.filter((other) => other.aliasOf === mailbox.id)
    : [];

  const sectionAddress = mailbox
    ? {
        mailboxId: mailbox.id,
        address: mailbox.address,
        displayName: mailbox.displayName,
        // The form's choices, so a section can follow them at once.
        delivery: form.delivery,
        forwardTo:
          form.delivery === "forward"
            ? forwardDestinations(form.forwardTo)
            : [],
      }
    : null;

  return (
    // A nested form would submit the surrounding editor; this one stands alone in the DOM tree.
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
              placeholder={owner.kind === "team" ? owner.team.slug : "name"}
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
      <DeliveryFields
        idPrefix={idPrefix}
        owner={owner.kind}
        value={form}
        onChange={(next) => {
          // A section's error goes with it when the delivery hides it.
          if (next.delivery !== form.delivery) setSectionError(null);
          setForm(next);
        }}
        aliasTargets={aliasTargets}
        domain={mailbox?.domain ?? address.domain}
        fixed={Boolean(mailbox?.isPrimary)}
      />
      {sectionAddress ? (
        <AddressSectionsProvider sections={sections}>
          {clientModules().flatMap((module) =>
            owner.kind === "team"
              ? (module.teamAddress ?? []).map(({ id, Component }) => (
                  // Enter in a module's section doesn't save the address.
                  <div key={`${module.name}:${id}`} data-module-section>
                    <Component
                      address={{ ...sectionAddress, teamId: owner.team.id }}
                    />
                  </div>
                ))
              : (module.userAddress ?? []).map(({ id, Component }) => (
                  <div key={`${module.name}:${id}`} data-module-section>
                    <Component
                      address={{
                        ...sectionAddress,
                        userId: owner.user.id,
                        isPrimary: Boolean(mailbox?.isPrimary),
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
        {mailbox && !mailbox.isPrimary ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={remove.isPending}
            onClick={async () => {
              const keepsMail = mailbox.delivery === "inbox";

              const confirmed = await confirm({
                title: `Delete ${mailbox.address}?`,
                description: [
                  "The address stops receiving mail.",
                  keepsMail
                    ? owner.kind === "person"
                      ? `All of its mail is deleted for ${owner.user.name}.`
                      : "All of its mail is deleted."
                    : null,
                  aliases.length
                    ? `Its aliases are deleted too: ${aliases.map((alias) => alias.address).join(", ")}.`
                    : null,
                  keepsMail || aliases.length ? "This cannot be undone." : null,
                ]
                  .filter(Boolean)
                  .join(" "),
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
            !deliveryComplete(form) ||
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
