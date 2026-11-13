import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  Clipboard,
  LoaderCircle,
  Plus,
  RefreshCw,
  Webhook,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Skeleton } from "../components/ui/skeleton";
import { api, responseJson } from "../lib/api";
import { cn } from "../lib/utils";
import { AdminListEmpty, adminListClass, adminPanelClass } from "./admin-panel";
import type { AdminWebhook, AdminWebhookDelivery } from "./types";
import { WebhookEditor, webhookEventLabel } from "./webhook-editor";

function formatDate(value: string | Date | null) {
  if (!value) return "Not attempted";

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function DeliveryHistory({
  deliveries,
  webhooks,
  refreshing,
  onRefresh,
}: {
  deliveries: AdminWebhookDelivery[];
  webhooks: AdminWebhook[];
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const endpointNames = new Map(
    webhooks.map((webhook) => [webhook.id, webhook.name])
  );

  return (
    <section>
      <div className="flex items-end justify-between gap-4 px-1">
        <div>
          <p className="text-sm font-semibold">Recent deliveries</p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Latest 50 attempts across the account.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
        >
          {refreshing ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <RefreshCw />
          )}
          Refresh
        </Button>
      </div>
      <div className={cn(adminListClass, "mt-3")}>
        {deliveries.length ? (
          deliveries.map((delivery) => (
            <div
              key={delivery.id}
              className="grid gap-2 px-5 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-medium">
                    {delivery.eventType === "webhook.test"
                      ? "Webhook test"
                      : webhookEventLabel(delivery.eventType)}
                  </p>
                  <Badge
                    variant={
                      delivery.status === "delivered"
                        ? "success"
                        : delivery.status === "failed"
                          ? "destructive"
                          : "outline"
                    }
                  >
                    {delivery.status}
                  </Badge>
                </div>
                <p className="text-muted-foreground mt-1 truncate text-xs">
                  {endpointNames.get(delivery.webhookId) ?? "Deleted endpoint"}
                  {delivery.responseStatus
                    ? ` · HTTP ${delivery.responseStatus}`
                    : ""}
                  {` · ${delivery.attempts} ${delivery.attempts === 1 ? "attempt" : "attempts"}`}
                </p>
                {delivery.error ? (
                  <p className="text-destructive mt-1 truncate font-mono text-[11px]">
                    {delivery.error}
                  </p>
                ) : null}
                {delivery.responseBody ? (
                  <p className="text-muted-foreground mt-1 truncate font-mono text-[11px]">
                    {delivery.responseBody}
                  </p>
                ) : null}
              </div>
              <p className="text-muted-foreground text-xs sm:text-right">
                {formatDate(delivery.lastAttemptAt ?? delivery.createdAt)}
              </p>
            </div>
          ))
        ) : (
          <AdminListEmpty title="No deliveries yet">
            Each attempt to deliver an event shows here, with its response.
          </AdminListEmpty>
        )}
      </div>
    </section>
  );
}

export function WebhooksManager({
  selectedId,
  onSelect,
}: {
  selectedId?: string;
  onSelect: (id?: string) => void;
}) {
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState<string>();
  const [copied, setCopied] = useState(false);

  const settings = useQuery({
    queryKey: ["admin-webhooks"],
    queryFn: async () => responseJson(await api.api.admin.webhooks.$get()),
  });

  if (settings.isLoading) {
    return (
      <Skeleton
        className={selectedId ? "h-[34rem] max-w-3xl" : "h-72 max-w-3xl"}
      />
    );
  }

  if (settings.isError) {
    return (
      <div className={`${adminPanelClass} p-8 text-center`}>
        <p className="text-destructive text-sm">
          Could not load webhook settings.
        </p>
        <Button
          className="mt-4"
          variant="outline"
          onClick={() => void settings.refetch()}
        >
          <RefreshCw /> Retry
        </Button>
      </div>
    );
  }

  const webhooks = settings.data?.webhooks ?? [];
  const deliveries = settings.data?.deliveries ?? [];

  const selected =
    selectedId === "new"
      ? undefined
      : webhooks.find((webhook) => webhook.id === selectedId);

  const editingNew = selectedId === "new";

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["admin-webhooks"] });
  }

  return (
    <>
      {selectedId ? (
        selectedId !== "new" && !selected ? (
          <div
            className={`${adminPanelClass} max-w-3xl px-6 py-12 text-center`}
          >
            <p className="text-muted-foreground text-sm">
              Webhook endpoint not found.
            </p>
          </div>
        ) : (
          <div className="max-w-3xl">
            <WebhookEditor
              key={editingNew ? "new" : selected?.id}
              webhook={editingNew ? undefined : selected}
              mailboxes={settings.data?.mailboxes ?? []}
              onSecret={(value) => {
                setCopied(false);
                setSecret(value);
              }}
              onSaved={async (id) => {
                await refresh();
                onSelect(id);
              }}
              onDeleted={async () => {
                await refresh();
                onSelect();
              }}
            />
          </div>
        )
      ) : (
        <div className="max-w-3xl space-y-10">
          <section>
            <div className="flex items-end justify-between gap-4 px-1">
              <div>
                <p className="text-sm font-semibold">Endpoints</p>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {webhooks.length === 0
                    ? "Systems that receive workspace events."
                    : webhooks.length === 1
                      ? "1 endpoint receives workspace events."
                      : `${webhooks.length} endpoints receive workspace events.`}
                </p>
              </div>
              <Button size="sm" onClick={() => onSelect("new")}>
                <Plus /> Add endpoint
              </Button>
            </div>
            <div className={cn(adminListClass, "mt-3")}>
              {webhooks.map((webhook) => (
                <button
                  key={webhook.id}
                  type="button"
                  className="hover:bg-accent/45 flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors"
                  onClick={() => onSelect(webhook.id)}
                >
                  <span className="bg-primary/12 text-primary grid size-9 shrink-0 place-items-center rounded-lg">
                    <Webhook className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">
                      {webhook.name}
                    </span>
                    <span className="text-muted-foreground block truncate text-[11px]">
                      {webhook.url}
                    </span>
                    {webhook.mailboxes.some((mailbox) => !mailbox.available) ? (
                      <span className="text-warning mt-0.5 block truncate text-[11px]">
                        Mail from{" "}
                        {
                          webhook.mailboxes.filter(
                            (mailbox) => !mailbox.available
                          ).length
                        }{" "}
                        of {webhook.mailboxes.length} mailboxes is not delivered
                      </span>
                    ) : null}
                  </span>
                  {webhook.managedBy === "deployment" ? (
                    <Badge variant="info">Managed by deployment</Badge>
                  ) : null}
                  {webhook.mailboxes.some((mailbox) => !mailbox.available) ? (
                    <Badge variant="warning">Partly unavailable</Badge>
                  ) : null}
                  {webhook.enabled ? null : (
                    <Badge variant="outline">Off</Badge>
                  )}
                  <ChevronRight className="text-muted-foreground size-4 shrink-0" />
                </button>
              ))}
              {webhooks.length ? null : (
                <AdminListEmpty Icon={Webhook} title="No endpoints yet">
                  Add an endpoint to send signed workspace events, like new mail
                  or people changes, to another system.
                </AdminListEmpty>
              )}
            </div>
          </section>

          <DeliveryHistory
            deliveries={deliveries}
            webhooks={webhooks}
            refreshing={settings.isFetching}
            onRefresh={() => void settings.refetch()}
          />
        </div>
      )}

      <Dialog
        open={Boolean(secret)}
        onOpenChange={(open) => {
          if (!open) setSecret(undefined);
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Copy the signing secret</DialogTitle>
            <DialogDescription>
              This secret will not be shown again. Store it in the receiving
              service before closing this window.
            </DialogDescription>
          </DialogHeader>
          <div className="bg-surface-sunken ring-border p-4 font-mono text-xs leading-relaxed break-all ring-1">
            {secret}
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Deliveries follow{" "}
            <a
              className="underline underline-offset-2"
              href="https://www.standardwebhooks.com/"
              target="_blank"
              rel="noreferrer"
            >
              Standard Webhooks
            </a>
            : verify them with its library for your language and this secret.
          </p>
          <DialogFooter>
            <Button
              type="button"
              onClick={() => {
                if (!secret) return;
                void navigator.clipboard
                  .writeText(secret)
                  .then(() => {
                    setCopied(true);
                    toast.success("Signing secret copied");
                  })
                  .catch(() =>
                    toast.error("Signing secret could not be copied")
                  );
              }}
            >
              {copied ? <Check /> : <Clipboard />}
              {copied ? "Copied" : "Copy secret"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
