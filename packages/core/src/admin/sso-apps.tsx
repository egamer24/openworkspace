import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  FileKey2,
  KeyRound,
  Plus,
  Shield,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { api, responseJson } from "../lib/api";
import { AdminListEmpty, adminListClass, adminPanelClass } from "./admin-panel";
import { OidcAppDetail, SamlAppDetail } from "./sso-app-detail";
import type { SsoAppRow } from "./sso-app-model";
import { SsoAppWizard } from "./sso-app-wizard";
import type {
  AdminOidcClient,
  AdminOidcProvider,
  AdminSamlApplication,
  AdminSamlProvider,
  AdminTeam,
} from "./types";

/** OpenID Connect and SAML apps on one page, each opening its own detail view. */
export function SsoApps({
  oidcClients,
  samlApplications,
  oidcProvider,
  samlProvider,
  teams,
  loading,
  selectedId,
  onSelect,
}: {
  oidcClients: AdminOidcClient[];
  samlApplications: AdminSamlApplication[];
  oidcProvider: AdminOidcProvider;
  samlProvider: AdminSamlProvider;
  teams: AdminTeam[];
  loading: boolean;
  selectedId?: string;
  onSelect: (id?: string) => void;
}) {
  const [secret, setSecret] = useState<{ clientId: string; value: string }>();
  const selectedClient = oidcClients.find((client) => client.id === selectedId);

  const selectedSaml = samlApplications.find(
    (application) => application.id === selectedId
  );

  const samlDetails = useQuery({
    queryKey: ["saml-application", selectedSaml?.id],
    enabled: Boolean(selectedSaml),
    gcTime: 0,
    retry: false,
    staleTime: Infinity,
    queryFn: async () => {
      if (!selectedSaml) throw new Error("SAML app is not selected");

      return responseJson(
        await api.api.admin["saml-applications"][":id"].$get({
          param: { id: selectedSaml.id },
        })
      );
    },
  });

  if (loading) {
    return (
      <div className="max-w-3xl space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (selectedId === "new") {
    return (
      <SsoAppWizard
        oidcProvider={oidcProvider}
        samlProvider={samlProvider}
        teams={teams}
        onFinished={(id) => onSelect(id)}
      />
    );
  }

  if (selectedClient) {
    return (
      <OidcAppDetail
        key={selectedClient.id}
        client={selectedClient}
        provider={oidcProvider}
        teams={teams}
        secret={
          secret?.clientId === selectedClient.id ? secret.value : undefined
        }
        onSecret={(value) => setSecret({ clientId: selectedClient.id, value })}
        onDeleted={() => onSelect()}
      />
    );
  }

  if (selectedSaml) {
    if (samlDetails.isPending) return <Skeleton className="h-96 max-w-3xl" />;

    if (samlDetails.isError || !samlDetails.data) {
      return (
        <div className={`${adminPanelClass} max-w-3xl px-6 py-12 text-center`}>
          <p className="text-muted-foreground text-sm">
            This app could not be loaded.
          </p>
          <Button
            className="mt-4"
            variant="outline"
            onClick={() => void samlDetails.refetch()}
          >
            Retry
          </Button>
        </div>
      );
    }

    return (
      <SamlAppDetail
        key={selectedSaml.id}
        application={{ ...selectedSaml, ...samlDetails.data }}
        provider={samlProvider}
        teams={teams}
        onDeleted={() => onSelect()}
      />
    );
  }

  if (selectedId) {
    return (
      <div className={`${adminPanelClass} max-w-3xl px-6 py-12 text-center`}>
        <p className="text-muted-foreground text-sm">
          This app was not found. It may have been removed.
        </p>
      </div>
    );
  }

  const rows: SsoAppRow[] = [
    ...oidcClients.map((app) => ({ protocol: "oidc" as const, app })),
    ...samlApplications.map((app) => ({ protocol: "saml" as const, app })),
  ].sort((left, right) => left.app.name.localeCompare(right.app.name));

  const notReady = [
    oidcProvider.configured ? null : "OpenID Connect",
    samlProvider.configured ? null : "SAML",
  ].filter(Boolean);

  return (
    <div className="max-w-3xl space-y-3">
      {notReady.length ? (
        <p className="bg-warning/12 ring-warning/30 flex items-start gap-2 rounded-lg px-3.5 py-2.5 text-xs leading-5 ring-1">
          <TriangleAlert className="text-warning mt-0.5 size-3.5 shrink-0" />
          {notReady.join(" and ")} sign-in is not set up in this deployment yet.
          Apps can be added, but nobody can sign in to them until it is.
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-4 px-1">
        <p className="text-muted-foreground text-xs">
          {rows.length
            ? rows.length === 1
              ? "1 app"
              : `${rows.length} apps`
            : null}
        </p>
        <Button
          size="sm"
          onClick={() => {
            setSecret(undefined);
            onSelect("new");
          }}
        >
          <Plus /> Add an app
        </Button>
      </div>
      <div className={adminListClass}>
        {rows.map((row) => {
          const detail =
            row.protocol === "oidc"
              ? (row.app.redirectUris[0] ?? row.app.id)
              : row.app.entityId;

          return (
            <button
              key={row.app.id}
              type="button"
              className="hover:bg-accent/45 flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors"
              onClick={() => onSelect(row.app.id)}
            >
              <span className="bg-primary/12 text-primary grid size-9 shrink-0 place-items-center rounded-lg">
                {row.protocol === "oidc" ? (
                  <Shield className="size-4" />
                ) : (
                  <FileKey2 className="size-4" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">
                  {row.app.name}
                </span>
                <span className="text-muted-foreground block truncate font-mono text-[11px]">
                  {detail}
                </span>
              </span>
              <Badge variant="outline">
                {row.protocol === "oidc" ? "OIDC" : "SAML"}
              </Badge>
              {row.app.managedBy === "deployment" ? (
                <Badge variant="info">Managed by deployment</Badge>
              ) : null}
              {row.app.enabled ? null : <Badge variant="outline">Off</Badge>}
              <ChevronRight className="text-muted-foreground size-4 shrink-0" />
            </button>
          );
        })}
        {rows.length === 0 ? (
          <AdminListEmpty Icon={KeyRound} title="No apps yet">
            Add an app to let people sign in to it with their workspace account.
          </AdminListEmpty>
        ) : null}
      </div>
    </div>
  );
}
