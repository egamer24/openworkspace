import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, LoaderCircle, Shuffle, VenetianMask } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "@/admin/admin-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, responseJson } from "@/lib/api";
import { useMailboxes } from "@/mail/use-mail-data";

const queryKey = ["throwaway-addresses"];

function copyAddress(address: string) {
  void navigator.clipboard.writeText(address).then(
    () => toast.success(`Copied ${address}`),
    () => toast.error("Could not copy the address"),
  );
}

export function ThrowawayAddressSettings() {
  const client = useQueryClient();
  const mailboxes = useMailboxes();
  const sendable = (mailboxes.data?.mailboxes ?? []).filter((mailbox) => mailbox.canSend);
  const [mailboxId, setMailboxId] = useState<string>();
  const [label, setLabel] = useState("");
  const targetId = mailboxId ?? sendable[0]?.id;
  const addresses = useQuery({
    queryKey,
    queryFn: async () => responseJson(await api.api.mail["throwaway-addresses"].$get()),
  });
  const create = useMutation({
    mutationFn: async () => responseJson(await api.api.mail["throwaway-addresses"].$post({
      json: { mailboxId: targetId!, label: label.trim() || null },
    })),
    onSuccess: async ({ address }) => {
      setLabel("");
      // Clipboard writes need a direct click, so offer the copy as an action.
      toast.success(`Created ${address.address}`, {
        action: { label: "Copy", onClick: () => copyAddress(address.address) },
      });
      await client.invalidateQueries({ queryKey });
    },
    onError: (error) => toast.error(error.message),
  });
  const toggle = useMutation({
    mutationFn: async (input: { id: string; enabled: boolean }) => responseJson(
      await api.api.mail["throwaway-addresses"][":id"].$patch({
        param: { id: input.id },
        json: { enabled: input.enabled },
      }),
    ),
    onSuccess: () => client.invalidateQueries({ queryKey }),
    onError: (error) => toast.error(error.message),
  });
  const mailboxAddress = (id: string | null) =>
    mailboxes.data?.mailboxes.find((mailbox) => mailbox.id === id)?.address ?? "a mailbox you left";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (targetId) create.mutate();
  }

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={VenetianMask}
        title="Throwaway addresses"
        description="Random receive-only addresses for sign-ups and one-off contacts. Turn one off and mail to it bounces."
      />
      <AdminPanelBody className="space-y-5">
        {mailboxes.isSuccess && sendable.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            You need send access to a mailbox to create throwaway addresses.
          </p>
        ) : (
          <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={submit}>
            <div className="space-y-1.5">
              <Label htmlFor="throwaway-label">Label (only you see it)</Label>
              <Input
                id="throwaway-label"
                value={label}
                maxLength={80}
                placeholder="e.g. Shop newsletter"
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="throwaway-mailbox">Deliver to</Label>
              <Select value={targetId ?? ""} onValueChange={(value) => value && setMailboxId(value)}>
                <SelectTrigger id="throwaway-mailbox" className="w-full">
                  <SelectValue>
                    {sendable.find((mailbox) => mailbox.id === targetId)?.address ?? "Choose a mailbox"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {sendable.map((mailbox) => (
                    <SelectItem key={mailbox.id} value={mailbox.id}>{mailbox.address}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={!targetId || create.isPending}>
              {create.isPending ? <LoaderCircle className="animate-spin" /> : <Shuffle />}
              Generate
            </Button>
          </form>
        )}

        {addresses.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : addresses.data?.addresses.length ? (
          <ul className="divide-y divide-border/60 border-y border-border/70">
            {addresses.data.addresses.map((row) => (
              <li key={row.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <code className="truncate text-sm">{row.address}</code>
                    {!row.enabled && <Badge variant="outline">Off</Badge>}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {row.label ? `${row.label} · ` : ""}→ {mailboxAddress(row.mailboxId)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Copy ${row.address}`}
                  onClick={() => copyAddress(row.address)}
                >
                  <Copy />
                </Button>
                <Switch
                  aria-label={`Receive mail at ${row.address}`}
                  checked={row.enabled}
                  disabled={toggle.isPending}
                  onCheckedChange={(enabled) => toggle.mutate({ id: row.id, enabled })}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No throwaway addresses yet.</p>
        )}
        {addresses.data && (
          <p className="text-xs text-muted-foreground">
            {addresses.data.addresses.length} of {addresses.data.limit} used. Turned-off addresses still count.
          </p>
        )}
      </AdminPanelBody>
    </div>
  );
}
