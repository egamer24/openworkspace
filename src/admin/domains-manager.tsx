import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Globe2,
  LoaderCircle,
  Plus,
  Save,
  Star,
  Trash2,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, responseJson } from "@/lib/api";
import { CloudflareConnect, DomainOnboarding } from "./cloudflare-onboarding";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "./admin-panel";
import type { AdminDomain, DomainInput } from "./types";

export function DomainsManager({
  domains,
  loading,
  cloudflareOnboarding,
}: {
  domains: AdminDomain[];
  loading: boolean;
  cloudflareOnboarding: boolean;
}) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [zoneId, setZoneId] = useState("");
  const create = useMutation({
    mutationFn: async (input: DomainInput) => responseJson(
      await api.api.admin.domains.$post({ json: input }),
    ),
    onSuccess: async () => {
      setName("");
      setZoneId("");
      await client.invalidateQueries({ queryKey: ["admin-state"] });
      toast.success("Domain added");
    },
    onError: (error) => toast.error(error.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate({
      name,
      cloudflareZoneId: zoneId.trim() || null,
    });
  }

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader Icon={Globe2} title="Domains" />
      <AdminPanelBody className="space-y-5">
        {cloudflareOnboarding ? <CloudflareConnect /> : null}
        <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="domain-name">Domain</Label>
            <Input
              id="domain-name"
              placeholder="example.com"
              value={name}
              onChange={(event) => setName(event.target.value.toLowerCase())}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="domain-zone-id">Cloudflare Zone ID</Label>
            <Input
              id="domain-zone-id"
              className="font-mono text-xs"
              placeholder="Optional"
              value={zoneId}
              onChange={(event) => setZoneId(event.target.value)}
            />
          </div>
          <Button className="self-end" type="submit" disabled={create.isPending || !name.trim()}>
            {create.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />}
            Add
          </Button>
        </form>
        <div className="divide-y divide-border/60 border-y border-border/70">
          {loading ? (
            <div className="py-5 text-sm text-muted-foreground">Loading…</div>
          ) : domains.map((domain) => (
            <DomainRow
              key={domain.id}
              domain={domain}
              cloudflareOnboarding={cloudflareOnboarding}
            />
          ))}
        </div>
      </AdminPanelBody>
    </div>
  );
}

function DomainRow({
  domain,
  cloudflareOnboarding,
}: {
  domain: AdminDomain;
  cloudflareOnboarding: boolean;
}) {
  const client = useQueryClient();
  const [zoneId, setZoneId] = useState(domain.cloudflareZoneId ?? "");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const update = useMutation({
    mutationFn: async (input: { cloudflareZoneId?: string | null; isPrimary?: true }) =>
      responseJson(await api.api.admin.domains[":id"].$patch({
        param: { id: domain.id },
        json: input,
      })),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["admin-state"] });
      toast.success("Domain updated");
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: async () => responseJson(
      await api.api.admin.domains[":id"].$delete({ param: { id: domain.id } }),
    ),
    onSuccess: async () => {
      setDeleteOpen(false);
      await client.invalidateQueries({ queryKey: ["admin-state"] });
      toast.success("Domain deleted");
    },
    onError: (error) => toast.error(error.message),
  });
  const pending = update.isPending || remove.isPending;
  const normalizedZoneId = zoneId.trim() || null;
  const zoneChanged = normalizedZoneId !== domain.cloudflareZoneId;

  return (
    <>
      <div className="grid items-end gap-3 py-4 sm:grid-cols-[minmax(9rem,1fr)_minmax(12rem,1fr)_auto]">
        <div className="min-w-0 self-center">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold">{domain.name}</p>
            {domain.isPrimary ? <Badge><Check /> Primary</Badge> : null}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="sr-only" htmlFor={`zone-${domain.id}`}>Cloudflare Zone ID</Label>
          <Input
            id={`zone-${domain.id}`}
            className="font-mono text-xs"
            placeholder="Cloudflare Zone ID"
            value={zoneId}
            onChange={(event) => setZoneId(event.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={pending || !zoneChanged}
            onClick={() => update.mutate({ cloudflareZoneId: normalizedZoneId })}
          >
            <Save /> Save
          </Button>
          {!domain.isPrimary ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => update.mutate({
                  isPrimary: true,
                  cloudflareZoneId: normalizedZoneId,
                })}
              >
                <Star /> Primary
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={pending}
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 /> Delete
              </Button>
            </>
          ) : null}
        </div>
        {cloudflareOnboarding ? <DomainOnboarding domain={domain} /> : null}
      </div>

      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!pending) setDeleteOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {domain.name}?</DialogTitle>
            <DialogDescription>
              The domain and its Cloudflare Zone ID are removed from this account.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setDeleteOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              Delete domain
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
