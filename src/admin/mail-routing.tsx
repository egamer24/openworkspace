import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AtSign,
  Forward,
  Inbox,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, responseJson } from "@/lib/api";
import { adminPanelClass, AdminPanelBody, AdminPanelHeader } from "./admin-panel";
import type { AdminMailbox, AdminRouting } from "./types";

const routingKey = ["admin-routing"];
const NO_MAILBOX = "none";
const REJECT = "reject";

function useRoutingMutation<T>(run: (input: T) => Promise<unknown>, success: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: routingKey });
      toast.success(success);
    },
    onError: (error) => toast.error(error.message),
  });
}

function MailboxSelect({
  id,
  value,
  onChange,
  mailboxes,
  emptyValue,
  emptyLabel,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  mailboxes: AdminMailbox[];
  emptyValue: string;
  emptyLabel: string;
}) {
  const label = mailboxes.find((mailbox) => mailbox.id === value)?.address ?? emptyLabel;
  return (
    <Select value={value} onValueChange={(next) => onChange(next ?? emptyValue)}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false}>
        <SelectItem value={emptyValue}>{emptyLabel}</SelectItem>
        {mailboxes.map((mailbox) => (
          <SelectItem key={mailbox.id} value={mailbox.id}>{mailbox.address}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function MailRouting({ mailboxes }: { mailboxes: AdminMailbox[] }) {
  const routing = useQuery({
    queryKey: routingKey,
    queryFn: async () => responseJson(await api.api.admin.routing.$get()),
  });
  const data = routing.data;
  const mailboxAddress = (id: string | null) =>
    mailboxes.find((mailbox) => mailbox.id === id)?.address ?? null;

  return (
    <div className="space-y-6">
      <Destinations
        destinations={data?.destinations ?? []}
        cloudflareConfigured={data?.cloudflareConfigured ?? false}
        manualStep={data?.manualDestinationStep ?? ""}
        loading={routing.isLoading}
      />
      <Addresses
        addresses={data?.addresses ?? []}
        destinations={data?.destinations ?? []}
        mailboxes={mailboxes}
        mailboxAddress={mailboxAddress}
        loading={routing.isLoading}
      />
      <UnknownRecipients domains={data?.domains ?? []} mailboxes={mailboxes} />
    </div>
  );
}

function Destinations({
  destinations,
  cloudflareConfigured,
  manualStep,
  loading,
}: {
  destinations: AdminRouting["destinations"];
  cloudflareConfigured: boolean;
  manualStep: string;
  loading: boolean;
}) {
  const [email, setEmail] = useState("");
  const add = useRoutingMutation(
    async (value: string) => responseJson(
      await api.api.admin.routing.destinations.$post({ json: { email: value } }),
    ).then(() => setEmail("")),
    "Destination added",
  );
  const refresh = useRoutingMutation(
    async (id: string) => responseJson(
      await api.api.admin.routing.destinations[":id"].refresh.$post({ param: { id } }),
    ),
    "Verification status refreshed",
  );
  const markVerified = useRoutingMutation(
    async ({ id, verified }: { id: string; verified: boolean }) => responseJson(
      await api.api.admin.routing.destinations[":id"].$patch({ param: { id }, json: { verified } }),
    ),
    "Destination updated",
  );
  const remove = useRoutingMutation(
    async (id: string) => responseJson(
      await api.api.admin.routing.destinations[":id"].$delete({ param: { id } }),
    ),
    "Destination removed",
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    add.mutate(email);
  }

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader Icon={Forward} title="Forwarding destinations" />
      <AdminPanelBody className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {cloudflareConfigured
            ? "Adding a destination creates it in Cloudflare Email Routing, which emails a verification link to it. Mail is only forwarded to verified destinations."
            : manualStep}
        </p>
        <form className="grid gap-3 sm:grid-cols-[1fr_auto]" onSubmit={submit}>
          <Input
            aria-label="Destination address"
            type="email"
            placeholder="someone@example.org"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <Button type="submit" disabled={add.isPending || !email.trim()}>
            {add.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />}
            Add
          </Button>
        </form>
        <ul className="divide-y divide-border/60 border-y border-border/70">
          {loading ? <li className="py-4 text-sm text-muted-foreground">Loading…</li> : null}
          {destinations.map((destination) => (
            <li key={destination.id} className="flex flex-wrap items-center gap-2 py-3 text-sm">
              <span className="min-w-0 flex-1 truncate">{destination.email}</span>
              <Badge variant={destination.verified ? "success" : "warning"}>
                {destination.verified ? "Verified" : "Pending verification"}
              </Badge>
              {cloudflareConfigured ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={refresh.isPending}
                  onClick={() => refresh.mutate(destination.id)}
                >
                  <RefreshCw /> Refresh
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={markVerified.isPending}
                  onClick={() => markVerified.mutate({
                    id: destination.id,
                    verified: !destination.verified,
                  })}
                >
                  {destination.verified ? "Mark unverified" : "Mark verified"}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={remove.isPending}
                onClick={() => remove.mutate(destination.id)}
              >
                <Trash2 /><span className="sr-only">Remove {destination.email}</span>
              </Button>
            </li>
          ))}
        </ul>
      </AdminPanelBody>
    </div>
  );
}

function Addresses({
  addresses,
  destinations,
  mailboxes,
  mailboxAddress,
  loading,
}: {
  addresses: AdminRouting["addresses"];
  destinations: AdminRouting["destinations"];
  mailboxes: AdminMailbox[];
  mailboxAddress: (id: string | null) => string | null;
  loading: boolean;
}) {
  const [address, setAddress] = useState("");
  const [mailboxId, setMailboxId] = useState(NO_MAILBOX);
  const [destinationIds, setDestinationIds] = useState<string[]>([]);
  const [keepCopy, setKeepCopy] = useState(true);
  const verified = destinations.filter((destination) => destination.verified);
  const emailFor = (id: string) => destinations.find((item) => item.id === id)?.email ?? id;
  const create = useRoutingMutation(
    async () => responseJson(await api.api.admin.routing.addresses.$post({
      json: {
        address,
        mailboxId: mailboxId === NO_MAILBOX ? null : mailboxId,
        destinationIds,
        keepCopy,
      },
    })).then(() => {
      setAddress("");
      setMailboxId(NO_MAILBOX);
      setDestinationIds([]);
      setKeepCopy(true);
    }),
    "Address saved",
  );
  const remove = useRoutingMutation(
    async (id: string) => responseJson(
      await api.api.admin.routing.addresses[":id"].$delete({ param: { id } }),
    ),
    "Address removed",
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate(undefined);
  }

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader Icon={AtSign} title="Aliases and forwarding" />
      <AdminPanelBody className="space-y-4">
        <p className="text-sm text-muted-foreground">
          An alias delivers into an existing mailbox. Without a mailbox the address
          only forwards. Enter a mailbox's own address to forward its mail too.
        </p>
        <form className="space-y-3" onSubmit={submit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="routing-address">Address</Label>
              <Input
                id="routing-address"
                type="email"
                placeholder="hello@example.com"
                value={address}
                onChange={(event) => setAddress(event.target.value.toLowerCase())}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="routing-mailbox">Deliver to mailbox</Label>
              <MailboxSelect
                id="routing-mailbox"
                value={mailboxId}
                onChange={setMailboxId}
                mailboxes={mailboxes}
                emptyValue={NO_MAILBOX}
                emptyLabel="No mailbox (forward only)"
              />
            </div>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Forward to</legend>
            {verified.length === 0 ? (
              <p className="text-sm text-muted-foreground">No verified destinations yet.</p>
            ) : verified.map((destination) => (
              <Label key={destination.id} className="flex items-center gap-2 font-normal">
                <Checkbox
                  checked={destinationIds.includes(destination.id)}
                  onCheckedChange={(checked) => setDestinationIds((current) =>
                    checked === true
                      ? [...current, destination.id]
                      : current.filter((id) => id !== destination.id))}
                />
                {destination.email}
              </Label>
            ))}
          </fieldset>
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox
              checked={keepCopy}
              onCheckedChange={(checked) => setKeepCopy(checked === true)}
            />
            Keep a copy in the mailbox when forwarding
          </Label>
          <Button type="submit" disabled={create.isPending || !address.trim()}>
            {create.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />}
            Save address
          </Button>
        </form>
        <ul className="divide-y divide-border/60 border-y border-border/70">
          {loading ? <li className="py-4 text-sm text-muted-foreground">Loading…</li> : null}
          {addresses.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{row.address}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {[
                    row.mailboxId
                      ? `→ ${mailboxAddress(row.mailboxId) ?? "mailbox"}${row.destinationIds.length && !row.keepCopy ? " (only if forwarding fails)" : ""}`
                      : null,
                    ...row.destinationIds.map((id) => `⇢ ${emailFor(id)}`),
                  ].filter(Boolean).join("  ")}
                </p>
              </div>
              <Badge variant="outline">
                {!row.mailboxId ? "Forward only" : row.destinationIds.length ? "Store and forward" : "Alias"}
              </Badge>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={remove.isPending}
                onClick={() => remove.mutate(row.id)}
              >
                <Trash2 /><span className="sr-only">Remove {row.address}</span>
              </Button>
            </li>
          ))}
        </ul>
      </AdminPanelBody>
    </div>
  );
}

function UnknownRecipients({
  domains,
  mailboxes,
}: {
  domains: AdminRouting["domains"];
  mailboxes: AdminMailbox[];
}) {
  const update = useRoutingMutation(
    async ({ id, mailboxId }: { id: string; mailboxId: string | null }) => responseJson(
      await api.api.admin.routing.domains[":id"]["unknown-recipients"].$put({
        param: { id },
        json: { mailboxId },
      }),
    ),
    "Unknown-recipient policy saved",
  );
  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader Icon={Inbox} title="Unknown recipients" />
      <AdminPanelBody className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Mail to an address with no mailbox, alias or forward is rejected, or delivered to a catch-all mailbox.
        </p>
        {domains.map((domain) => (
          <div key={domain.id} className="grid items-center gap-2 sm:grid-cols-[1fr_1fr]">
            <Label htmlFor={`unknown-${domain.id}`}>{domain.name}</Label>
            <MailboxSelect
              id={`unknown-${domain.id}`}
              value={domain.unknownRecipientMailboxId ?? REJECT}
              onChange={(value) => update.mutate({
                id: domain.id,
                mailboxId: value === REJECT ? null : value,
              })}
              mailboxes={mailboxes}
              emptyValue={REJECT}
              emptyLabel="Reject"
            />
          </div>
        ))}
      </AdminPanelBody>
    </div>
  );
}
