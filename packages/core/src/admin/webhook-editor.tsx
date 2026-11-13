import { useMutation } from "@tanstack/react-query";
import {
  FlaskConical,
  Inbox,
  LoaderCircle,
  TriangleAlert,
  RotateCw,
  Save,
  Trash2,
  Webhook,
} from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";

import { mergeWebhookEvents } from "../../shared/webhooks";
import type {
  WebhookEventDeclaration,
  WebhookEventType,
} from "../../shared/webhooks";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { api, responseJson } from "../lib/api";
import { clientModules } from "../modules";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
  AdminPanelHeader,
} from "./admin-panel";
import type { AdminWebhook, AdminWebhookMailbox, WebhookInput } from "./types";

/** The events this app can send: the modules' first, in their order, then core's. */
function offeredEvents(): Record<WebhookEventType, WebhookEventDeclaration> {
  return mergeWebhookEvents(clientModules());
}

export function webhookEventLabel(event: string) {
  return offeredEvents()[event]?.label ?? event;
}

/**
 * Mailboxes of an endpoint whose mail no longer goes out: whoever saved it
 * can't open them any more, or they were deleted.
 */
export function UnavailableMailboxes({ webhook }: { webhook: AdminWebhook }) {
  const unavailable = webhook.mailboxes.filter((mailbox) => !mailbox.available);

  if (!unavailable.length) return null;
  const deleted = unavailable.filter((mailbox) => mailbox.address === null);
  const lost = unavailable.filter((mailbox) => mailbox.address !== null);
  const owner = webhook.savedBy ?? "Whoever saved this endpoint";

  return (
    <div className="bg-warning/12 ring-warning/30 space-y-1 rounded-lg px-3.5 py-2.5 text-xs leading-5 text-pretty ring-1">
      {lost.length ? (
        <p className="flex items-start gap-2">
          <TriangleAlert className="text-warning mt-0.5 size-3.5 shrink-0" />
          <span>
            Mail from {lost.map((mailbox) => mailbox.address).join(", ")} is not
            delivered: {owner}, who saved this endpoint, can no longer open{" "}
            {lost.length === 1 ? "it" : "them"}. Someone who can has to save the
            endpoint again, or remove {lost.length === 1 ? "it" : "them"} here.
          </span>
        </p>
      ) : null}
      {deleted.length ? (
        <p className="flex items-start gap-2">
          <TriangleAlert className="text-warning mt-0.5 size-3.5 shrink-0" />
          <span>
            {deleted.length === 1
              ? "A mailbox it covered was deleted"
              : `${deleted.length} mailboxes it covered were deleted`}
            ; remove {deleted.length === 1 ? "it" : "them"} here.
          </span>
        </p>
      ) : null}
    </div>
  );
}

export function WebhookEditor({
  webhook,
  mailboxes,
  onSaved,
  onDeleted,
  onSecret,
}: {
  webhook?: AdminWebhook;
  /** Mailboxes the signed-in person may choose for mail events. */
  mailboxes: AdminWebhookMailbox[];
  onSaved: (id: string) => Promise<void>;
  onDeleted: () => Promise<void>;
  onSecret: (secret: string) => void;
}) {
  const managed = webhook?.managedBy === "deployment";
  const offered = offeredEvents();

  const [input, setInput] = useState<WebhookInput>(
    webhook
      ? {
          name: webhook.name,
          url: webhook.url,
          events: webhook.events,
          mailboxIds: webhook.mailboxIds,
          enabled: webhook.enabled,
        }
      : {
          name: "",
          url: "",
          events: Object.keys(offered).slice(0, 1),
          mailboxIds: [],
          enabled: true,
        }
  );

  const mailEvents = input.events.some((event) => offered[event]?.mailboxes);

  // The endpoint's own mailboxes stay listed, even ones the viewer can't choose.
  const mailboxChoices = [
    ...mailboxes,
    ...(webhook?.mailboxes ?? [])
      .filter((mailbox) => !mailboxes.some((item) => item.id === mailbox.id))
      .map((mailbox) => ({
        id: mailbox.id,
        address: mailbox.address ?? "Deleted mailbox",
        displayName:
          mailbox.address === null
            ? "Removed from the workspace"
            : "You can't open this mailbox",
        locked: true,
      })),
  ];

  // An endpoint keeps events no module here sends any more until they are unticked.
  const events = [...new Set([...Object.keys(offered), ...input.events])];

  const [confirmation, setConfirmation] = useState<"delete" | "rotate" | null>(
    null
  );

  const save = useMutation({
    mutationFn: async (payload: WebhookInput) => {
      if (webhook) {
        const result = await responseJson(
          await api.api.admin.webhooks[":id"].$put({
            param: { id: webhook.id },
            json: payload,
          })
        );

        return { webhook: result.webhook, signingSecret: undefined };
      }

      return responseJson(
        await api.api.admin.webhooks.$post({ json: payload })
      );
    },
    onSuccess: async (result) => {
      if (result.signingSecret) onSecret(result.signingSecret);
      toast.success(webhook ? "Webhook updated" : "Webhook created");
      await onSaved(result.webhook.id);
    },
    onError: (error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: async () => {
      if (!webhook) return;
      await responseJson(
        await api.api.admin.webhooks[":id"].$delete({
          param: { id: webhook.id },
        })
      );
    },
    onSuccess: async () => {
      toast.success("Webhook deleted");
      setConfirmation(null);
      await onDeleted();
    },
    onError: (error) => toast.error(error.message),
  });

  const rotate = useMutation({
    mutationFn: async () => {
      if (!webhook) throw new Error("Save the webhook first");

      return responseJson(
        await api.api.admin.webhooks[":id"]["rotate-secret"].$post({
          param: { id: webhook.id },
        })
      );
    },
    onSuccess: (result) => {
      setConfirmation(null);
      onSecret(result.signingSecret);
      toast.success("Signing secret rotated");
    },
    onError: (error) => toast.error(error.message),
  });

  const test = useMutation({
    mutationFn: async () => {
      if (!webhook) throw new Error("Save the webhook first");

      return responseJson(
        await api.api.admin.webhooks[":id"].test.$post({
          param: { id: webhook.id },
        })
      );
    },
    onSuccess: () => toast.success("Test delivery queued"),
    onError: (error) => toast.error(error.message),
  });

  function toggleEvent(event: WebhookEventType, checked: boolean) {
    setInput((current) => ({
      ...current,
      events: checked
        ? [...current.events, event]
        : current.events.filter((candidate) => candidate !== event),
    }));
  }

  function toggleMailbox(mailboxId: string, checked: boolean) {
    setInput((current) => ({
      ...current,
      mailboxIds: checked
        ? [...current.mailboxIds, mailboxId]
        : current.mailboxIds.filter((candidate) => candidate !== mailboxId),
    }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    // Mailboxes belong to mail events only.
    save.mutate(mailEvents ? input : { ...input, mailboxIds: [] });
  }

  const busy = save.isPending || remove.isPending || rotate.isPending;

  const valid =
    input.name.trim().length >= 2 &&
    input.url.startsWith("https://") &&
    input.events.length > 0 &&
    (!mailEvents || input.mailboxIds.length > 0);

  return (
    <>
      <form className={adminPanelClass} onSubmit={submit}>
        <AdminPanelHeader
          Icon={Webhook}
          title={webhook ? webhook.name : "New webhook"}
          description="Selected events are delivered across the workspace; mail only from the mailboxes chosen below."
        />
        <AdminPanelBody className="space-y-6">
          {managed ? (
            <p className="text-muted-foreground text-xs leading-relaxed">
              Declared in{" "}
              <code className="text-foreground/75 font-mono">
                alchemy.run.ts
              </code>
              : change it there and deploy. Its signing secret is the{" "}
              <code className="text-foreground/75 font-mono">Webhook</code>{" "}
              resource's
              <code className="text-foreground/75 ml-1 font-mono">secret</code>.
            </p>
          ) : null}
          <fieldset disabled={managed} className="min-w-0 space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="webhook-name">Name</Label>
                <Input
                  id="webhook-name"
                  value={input.name}
                  maxLength={80}
                  placeholder="Automation service"
                  onChange={(event) =>
                    setInput((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="webhook-url">Endpoint URL</Label>
                <Input
                  id="webhook-url"
                  type="url"
                  value={input.url}
                  maxLength={2048}
                  placeholder="https://example.com/webhooks/openworkspace"
                  className="font-mono text-xs"
                  onChange={(event) =>
                    setInput((current) => ({
                      ...current,
                      url: event.target.value,
                    }))
                  }
                />
                <p className="text-muted-foreground text-xs">
                  HTTPS is required.
                </p>
              </div>
            </div>

            <fieldset className="border-border/70 min-w-0 border-t pt-5">
              {/* Floated so the legend sits inside the box, under the rule, not on it. */}
              <legend className="float-left mb-3 w-full text-sm font-semibold">
                Events
              </legend>
              <div className="clear-left grid gap-x-6 gap-y-4 sm:grid-cols-2">
                {events.map((event) => (
                  <label
                    key={event}
                    className="flex cursor-pointer items-start gap-3"
                  >
                    <Checkbox
                      className="mt-0.5"
                      checked={input.events.includes(event)}
                      onCheckedChange={(checked) => toggleEvent(event, checked)}
                    />
                    <span>
                      <span className="block text-sm font-medium">
                        {offered[event]?.label ?? event}
                      </span>
                      <span className="text-muted-foreground mt-0.5 block text-xs leading-relaxed">
                        {offered[event]?.description ??
                          "Not sent by this workspace's modules."}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {mailEvents && !managed ? (
              <fieldset className="border-border/70 min-w-0 border-t pt-5">
                <legend className="float-left w-full text-sm font-semibold">
                  Mailboxes
                </legend>
                <p className="text-muted-foreground clear-left mb-3 pt-0.5 text-xs leading-relaxed">
                  Mail events carry the full message. Only mail from these
                  mailboxes is sent, and only while you can open them; you can
                  choose mailboxes you have access to.
                </p>
                {webhook ? (
                  <div className="mb-3">
                    <UnavailableMailboxes webhook={webhook} />
                  </div>
                ) : null}
                {mailboxChoices.length ? (
                  <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                    {mailboxChoices.map((mailbox) => {
                      const locked = "locked" in mailbox;

                      return (
                        <label
                          key={mailbox.id}
                          className="flex cursor-pointer items-start gap-3"
                        >
                          <Checkbox
                            className="mt-0.5"
                            checked={input.mailboxIds.includes(mailbox.id)}
                            // One you can't open may only be removed.
                            disabled={
                              locked && !input.mailboxIds.includes(mailbox.id)
                            }
                            onCheckedChange={(checked) =>
                              toggleMailbox(mailbox.id, checked)
                            }
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">
                              {mailbox.address}
                            </span>
                            <span className="text-muted-foreground mt-0.5 block truncate text-xs">
                              {mailbox.displayName}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-muted-foreground flex items-center gap-2 text-xs">
                    <Inbox className="size-3.5" /> You can't open any mailbox,
                    so no mail can be sent.
                  </p>
                )}
                {input.mailboxIds.length ? null : (
                  <p className="text-destructive mt-3 text-xs">
                    Choose at least one mailbox for mail events.
                  </p>
                )}
              </fieldset>
            ) : null}

            <div className="border-border/70 flex items-center justify-between gap-6 border-t pt-5">
              <div>
                <p className="text-sm font-medium">Endpoint enabled</p>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  Pausing preserves its URL, events, and delivery history.
                </p>
              </div>
              <Switch
                checked={input.enabled}
                onCheckedChange={(enabled) =>
                  setInput((current) => ({
                    ...current,
                    enabled,
                  }))
                }
              />
            </div>
          </fieldset>
        </AdminPanelBody>
        <AdminPanelFooter className="justify-between">
          <div className="flex flex-wrap gap-2">
            {webhook ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || test.isPending}
                  onClick={() => test.mutate()}
                >
                  {test.isPending ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <FlaskConical />
                  )}
                  Send test
                </Button>
                {managed ? null : (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setConfirmation("rotate")}
                    >
                      <RotateCw /> Rotate secret
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => setConfirmation("delete")}
                    >
                      <Trash2 /> Delete
                    </Button>
                  </>
                )}
              </>
            ) : null}
          </div>
          {managed ? null : (
            <Button type="submit" disabled={!valid || busy}>
              {save.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Save />
              )}
              {webhook ? "Save changes" : "Create webhook"}
            </Button>
          )}
        </AdminPanelFooter>
      </form>

      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmation === "delete"
                ? "Delete webhook?"
                : "Rotate signing secret?"}
            </DialogTitle>
            <DialogDescription>
              {confirmation === "delete"
                ? "Delivery stops immediately and its recent delivery history is removed."
                : "The current secret stops working immediately. Update the receiving service before sending more events."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={confirmation === "delete" ? "destructive" : "default"}
              disabled={busy}
              onClick={() =>
                confirmation === "delete" ? remove.mutate() : rotate.mutate()
              }
            >
              {busy ? <LoaderCircle className="animate-spin" /> : null}
              {confirmation === "delete" ? "Delete" : "Rotate secret"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
