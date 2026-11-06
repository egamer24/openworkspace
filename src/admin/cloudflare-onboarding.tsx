import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud, LoaderCircle, RefreshCw, Search, Wrench } from "lucide-react";
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
import type {
  DomainOnboardingStatus,
  DomainOnboardingStep,
} from "../../shared/domain-onboarding";
import type { AdminDomain } from "./types";

const stepLabels: Record<DomainOnboardingStep, string> = {
  routing: "Email Routing",
  catch_all: "Catch-all to Worker",
  sending: "Email Sending",
  events: "Delivery events",
  zone: "Zone ID saved",
};

const statusVariants: Record<
  DomainOnboardingStatus,
  "success" | "destructive" | "warning" | "outline"
> = {
  ok: "success",
  skipped: "success",
  failed: "destructive",
  drifted: "warning",
  rolled_back: "warning",
  manual: "outline",
};

type StepRow = {
  step: DomainOnboardingStep;
  status: DomainOnboardingStatus;
  detail: string | null;
};

type ConnectResult = {
  outcome: "connected" | "failed" | "mx_conflict";
  preflight: { foreignMx: unknown[] };
};

function connectRequest(input: { name: string; replaceMx: boolean }) {
  return api.api.admin.cloudflare.connect.$post({ json: input })
    .then(responseJson);
}

function reportConnect(result: ConnectResult) {
  if (result.outcome === "connected") toast.success("Domain connected");
  else if (result.outcome === "mx_conflict") {
    toast.error("The domain has MX records for another mail provider. Review them in Connect via Cloudflare.");
  } else toast.error("Setup failed; changes from this run were rolled back");
}

export function CloudflareConnect() {
  const client = useQueryClient();
  const [zoneName, setZoneName] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [replaceMx, setReplaceMx] = useState(false);
  const zones = useQuery({
    queryKey: ["cloudflare-zones"],
    queryFn: async () => responseJson(await api.api.admin.cloudflare.zones.$get()),
  });
  const label = subdomain.trim().toLowerCase().replace(/\.+$/u, "");
  const name = zoneName && label ? `${label}.${zoneName}` : zoneName;
  const preview = useMutation({
    mutationFn: async () => responseJson(
      await api.api.admin.cloudflare.preflight.$post({ json: { name } }),
    ),
    onError: (error) => toast.error(error.message),
  });
  const connect = useMutation({
    mutationFn: () => connectRequest({ name, replaceMx }),
    onSuccess: async (result) => {
      reportConnect(result);
      await client.invalidateQueries({ queryKey: ["admin-state"] });
    },
    onError: (error) => toast.error(error.message),
  });
  const plan = preview.data?.hostname === name ? preview.data : null;
  const conflict = Boolean(plan?.foreignMx.length);

  function submit(event: FormEvent) {
    event.preventDefault();
    setReplaceMx(false);
    preview.mutate();
  }

  return (
    <div className="space-y-3 rounded-lg border border-border/70 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Cloud className="size-4" /> Connect via Cloudflare
      </div>
      <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]" onSubmit={submit}>
        <div className="space-y-1.5">
          <Label htmlFor="cloudflare-zone">Zone</Label>
          <Select value={zoneName} onValueChange={(value) => setZoneName(value ?? "")}>
            <SelectTrigger id="cloudflare-zone" className="w-full">
              <SelectValue>
                {zoneName || (zones.isLoading ? "Loading…" : "Choose a zone")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false}>
              {zones.data?.zones.map((zone) => (
                <SelectItem key={zone.id} value={zone.name}>{zone.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cloudflare-subdomain">Subdomain</Label>
          <Input
            id="cloudflare-subdomain"
            placeholder="Optional, e.g. mail"
            value={subdomain}
            onChange={(event) => setSubdomain(event.target.value)}
          />
        </div>
        <Button
          className="self-end"
          type="submit"
          variant="outline"
          disabled={!zoneName || preview.isPending}
        >
          {preview.isPending ? <LoaderCircle className="animate-spin" /> : <Search />}
          Preview
        </Button>
      </form>
      {zones.error ? (
        <p className="text-sm text-destructive">{zones.error.message}</p>
      ) : null}
      {plan ? (
        <div className="space-y-3 text-sm">
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>Enable Email Routing for <b>{plan.hostname}</b></li>
            <li>
              Send the catch-all to this Worker
              {plan.catchAll && !plan.catchAll.targetsThisWorker
                ? ` (currently: ${plan.catchAll.current})`
                : ""}
            </li>
            <li>Onboard {plan.hostname} for Email Sending</li>
            <li>Save the zone ID on the domain</li>
          </ul>
          {conflict ? (
            <div className="space-y-2 rounded-md border border-destructive/40 p-3">
              <p>{plan.hostname} receives mail elsewhere. These MX records will be deleted:</p>
              <ul className="font-mono text-xs">
                {plan.foreignMx.map((record) => (
                  <li key={`${record.priority}-${record.content}`}>
                    {record.priority ?? ""} {record.content}
                  </li>
                ))}
              </ul>
              <Label className="flex items-center gap-2">
                <Checkbox
                  checked={replaceMx}
                  onCheckedChange={(checked) => setReplaceMx(checked === true)}
                />
                Replace these MX records
              </Label>
            </div>
          ) : null}
          <Button
            disabled={connect.isPending || (conflict && !replaceMx)}
            onClick={() => connect.mutate()}
          >
            {connect.isPending ? <LoaderCircle className="animate-spin" /> : <Cloud />}
            Connect {plan.hostname}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function DomainOnboarding({ domain }: { domain: AdminDomain }) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ["admin-state"] });
  const check = useMutation({
    mutationFn: async () => responseJson(
      await api.api.admin.domains[":id"].cloudflare.check.$post({
        param: { id: domain.id },
      }),
    ),
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });
  const repair = useMutation({
    mutationFn: () => connectRequest({ name: domain.name, replaceMx: false }),
    onSuccess: async (result) => {
      reportConnect(result);
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const steps: StepRow[] = domain.onboarding;
  const needsRepair = steps.some((step) =>
    step.status === "failed" || step.status === "drifted" || step.status === "rolled_back");
  const pending = check.isPending || repair.isPending;

  return (
    <div className="col-span-full space-y-2">
      {steps.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {steps.map((step) => (
            <li key={step.step} title={step.detail ?? undefined}>
              <Badge variant={statusVariants[step.status]}>
                {stepLabels[step.step]}: {step.status.replace("_", " ")}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {steps.filter((step) => step.detail).map((step) => (
        <p
          key={step.step}
          className={step.status === "manual"
            ? "text-xs text-muted-foreground"
            : "text-xs text-destructive"}
        >
          {stepLabels[step.step]}: {step.detail}
        </p>
      ))}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={pending} onClick={() => check.mutate()}>
          {check.isPending ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          Check
        </Button>
        {needsRepair ? (
          <Button variant="outline" size="sm" disabled={pending} onClick={() => repair.mutate()}>
            {repair.isPending ? <LoaderCircle className="animate-spin" /> : <Wrench />}
            Repair
          </Button>
        ) : null}
      </div>
    </div>
  );
}
