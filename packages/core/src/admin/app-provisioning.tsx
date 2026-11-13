import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  LoaderCircle,
  RefreshCw,
  Trash2,
  UsersRound,
} from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { useConfirm } from "../hooks/use-confirm";
import { api, responseJson } from "../lib/api";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
  AdminPanelHeader,
} from "./admin-panel";
import type { AdminOidcClient } from "./types";

type Provisioning = NonNullable<AdminOidcClient["provisioning"]>;

type AppKind = "oidc-clients" | "saml-applications";

function routes(kind: AppKind) {
  return kind === "oidc-clients"
    ? api.api.admin["oidc-clients"][":id"].provisioning
    : api.api.admin["saml-applications"][":id"].provisioning;
}

function formatTime(value: string | null) {
  return value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "never";
}

function origin(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * SCIM provisioning for one SSO application. Read-only for an app declared
 * in alchemy.run.ts, which is changed by deploying.
 */
export function AppProvisioning({
  kind,
  applicationId,
  provisioning,
  managed = false,
}: {
  kind: AppKind;
  applicationId: string;
  provisioning: Provisioning | null;
  managed?: boolean;
}) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(provisioning?.enabled ?? true);
  const [baseUrl, setBaseUrl] = useState(provisioning?.baseUrl ?? "");
  const [token, setToken] = useState("");
  const param = { id: applicationId };

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["admin-state"] });
  }

  const save = useMutation({
    mutationFn: async () =>
      responseJson(
        await routes(kind).$put({
          param,
          // JSON leaves an undefined token out: none typed, none sent.
          json: { enabled, baseUrl, token: token || undefined },
        })
      ),
    onSuccess: async () => {
      setToken("");
      toast.success(
        enabled
          ? "Provisioning saved; a sync has started"
          : "Provisioning saved"
      );
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const test = useMutation({
    mutationFn: async () =>
      responseJson(
        await routes(kind).test.$post({
          param,
          json: { baseUrl, token: token || undefined },
        })
      ),
    onSuccess: (result) => {
      if (result.reachable) {
        toast.success("The application accepted the URL and token");
      } else toast.error(result.error ?? "The application did not respond");
    },
    onError: (error) => toast.error(error.message),
  });

  const sync = useMutation({
    mutationFn: async () =>
      responseJson(await routes(kind).sync.$post({ param })),
    onSuccess: async () => {
      toast.success("Sync started");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: async () => responseJson(await routes(kind).$delete({ param })),
    onSuccess: async () => {
      setBaseUrl("");
      setToken("");
      toast.success("Provisioning removed");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  // The saved token is only ever sent to the server it was entered for.
  const movedServer = Boolean(
    provisioning && baseUrl && origin(baseUrl) !== origin(provisioning.baseUrl)
  );

  const canSubmit =
    Boolean(baseUrl) &&
    (Boolean(token) || (Boolean(provisioning) && !movedServer));

  const { confirm, dialog: confirmDialog } = useConfirm();

  return (
    <form className={`${adminPanelClass} max-w-3xl`} onSubmit={submit}>
      {confirmDialog}
      <AdminPanelHeader
        Icon={UsersRound}
        title="Provisioning (SCIM)"
        description="Creates people and teams in the application before they sign in, and deactivates people who lose access."
      >
        {provisioning ? (
          <Badge
            className="order-last"
            variant={provisioning.enabled ? "info" : "outline"}
          >
            {provisioning.enabled ? "On" : "Off"}
          </Badge>
        ) : null}
      </AdminPanelHeader>
      <AdminPanelBody className="space-y-4">
        {managed ? (
          <p className="bg-surface-sunken/60 text-muted-foreground ring-border rounded-lg px-3.5 py-2.5 text-xs leading-5 ring-1">
            {provisioning ? (
              <>
                This app's provisioning is managed by{" "}
                <code className="text-foreground/75 font-mono">
                  alchemy.run.ts
                </code>{" "}
                (its{" "}
                <code className="text-foreground/75 font-mono">
                  provisioning
                </code>{" "}
                option): change the URL, token or switch there and deploy. Sync
                now still works here.
              </>
            ) : (
              <>
                This app is declared in{" "}
                <code className="text-foreground/75 font-mono">
                  alchemy.run.ts
                </code>
                . To provision it, add{" "}
                <code className="text-foreground/75 font-mono">
                  provisioning
                </code>{" "}
                to its declaration there and deploy.
              </>
            )}
          </p>
        ) : null}
        {provisioning ? (
          <div className="bg-surface-sunken/50 ring-border grid gap-3 rounded-xl p-3.5 text-xs ring-1 sm:grid-cols-3">
            <Stat label="People" value={provisioning.users} />
            <Stat label="Deactivated" value={provisioning.deactivatedUsers} />
            <Stat label="Groups" value={provisioning.groups} />
            <p className="text-muted-foreground sm:col-span-3">
              {provisioning.syncing ? "Syncing now. " : null}
              Last sync {formatTime(provisioning.lastSyncAt)}
              {provisioning.lastSuccessAt
                ? `, last complete ${formatTime(provisioning.lastSuccessAt)}`
                : null}
              .
            </p>
            {provisioning.lastError ? (
              <p className="bg-destructive/10 text-destructive rounded-lg px-3 py-2 sm:col-span-3">
                {provisioning.lastError}
              </p>
            ) : provisioning.lastSuccessAt ? (
              <p className="text-success flex items-center gap-1.5 sm:col-span-3">
                <CheckCircle2 className="size-3.5" /> In sync
              </p>
            ) : null}
          </div>
        ) : null}
        <fieldset className="contents" disabled={managed}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`${applicationId}-scim-url`}>SCIM base URL</Label>
              <Input
                id={`${applicationId}-scim-url`}
                type="url"
                placeholder="https://app.example.com/scim/v2"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${applicationId}-scim-token`}>
                Bearer token
              </Label>
              <Input
                id={`${applicationId}-scim-token`}
                type="password"
                autoComplete="off"
                placeholder={
                  managed
                    ? provisioning
                      ? "Kept as a deployment secret"
                      : ""
                    : movedServer
                      ? "Needed for the new server"
                      : provisioning
                        ? "Saved; enter a new one to replace it"
                        : "From the application's SCIM settings"
                }
                value={token}
                onChange={(event) => setToken(event.target.value)}
                required={!provisioning || movedServer}
              />
              {movedServer ? (
                <p className="text-muted-foreground text-xs leading-5">
                  The URL is on another server, so the saved token won't be sent
                  to it.
                </p>
              ) : null}
            </div>
          </div>
          <p className="text-muted-foreground text-xs leading-5">
            People with access to this application are created there; those who
            lose access or are disabled are deactivated. Teams exposed in the
            groups claim become groups. Changes sync within a minute, and
            everything is re-checked hourly.
          </p>
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>Sync changes to this application</span>
            <Switch
              checked={enabled}
              disabled={managed}
              onCheckedChange={setEnabled}
            />
          </label>
        </fieldset>
      </AdminPanelBody>
      <AdminPanelFooter className="justify-between">
        <div className="flex gap-2">
          {provisioning && !managed ? (
            <Button
              type="button"
              variant="destructive"
              disabled={remove.isPending}
              onClick={async () => {
                const confirmed = await confirm({
                  title: "Stop provisioning?",
                  description:
                    "Changes to people and teams are no longer sent to the application. People already created in it stay there.",
                  action: "Stop provisioning",
                  destructive: true,
                });

                if (confirmed) remove.mutate();
              }}
            >
              <Trash2 /> Remove
            </Button>
          ) : null}
          {provisioning?.enabled ? (
            <Button
              type="button"
              variant="outline"
              disabled={sync.isPending}
              onClick={() => sync.mutate()}
            >
              {sync.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <RefreshCw />
              )}
              Sync now
            </Button>
          ) : null}
        </div>
        {managed ? null : (
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={test.isPending || !canSubmit}
              onClick={() => test.mutate()}
            >
              {test.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : null}
              Test connection
            </Button>
            <Button type="submit" disabled={save.isPending || !canSubmit}>
              {save.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : null}
              {provisioning ? "Save" : "Set up provisioning"}
            </Button>
          </div>
        )}
      </AdminPanelFooter>
    </form>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="text-base font-semibold tabular-nums">{value}</p>
    </div>
  );
}
