import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, LoaderCircle, Power, Unplug } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { useConfirm } from "../hooks/use-confirm";
import { api, responseJson } from "../lib/api";
import type { SuccessfulResponse } from "../lib/api";
import { cn } from "../lib/utils";
import {
  AdminListEmpty,
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "./admin-panel";

const QUERY_KEY = ["admin-mcp-clients"] as const;

type ConnectedAppsResponse = SuccessfulResponse<
  Awaited<ReturnType<(typeof api.api.admin)["mcp-clients"]["$get"]>>
>;

type ConnectedApp = ConnectedAppsResponse["clients"][number];

function formatDate(value: string | Date | null) {
  if (!value) return "never";

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function ScopeBadges({
  scopes,
}: {
  scopes: ConnectedApp["connections"][number]["scopes"];
}) {
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Granted scopes">
      {scopes.map((scope) => (
        <li key={scope.id}>
          <Tooltip>
            <TooltipTrigger render={<span />}>
              <Badge
                variant={scope.dangerous ? "destructive" : "outline"}
                className="font-mono text-[10px]"
              >
                {scope.id}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{scope.label}</TooltipContent>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}

/**
 * Administration > Connected apps: every app that registered itself (AI
 * agents, editors, mail apps) across the workspace, who connected it and with
 * what, and whether apps may register themselves at all. Each person's own
 * list is Settings > Connected apps.
 */
export function ConnectedApps() {
  const client = useQueryClient();
  const { confirm, dialog } = useConfirm();

  const apps = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () =>
      responseJson(await api.api.admin["mcp-clients"].$get()),
  });

  const refresh = () => client.invalidateQueries({ queryKey: QUERY_KEY });

  const registration = useMutation({
    mutationFn: async (allowed: boolean) =>
      responseJson(
        await api.api.admin["mcp-clients"].registration.$put({
          json: { allowed },
        })
      ),
    onSuccess: async (_, allowed) => {
      toast.success(
        allowed
          ? "Apps may register themselves"
          : "Apps can no longer register themselves"
      );
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) =>
      responseJson(
        await api.api.admin["mcp-clients"][":id"].$patch({
          param: { id },
          json: { enabled },
        })
      ),
    onSuccess: async (_, { enabled }) => {
      toast.success(
        enabled ? "App turned on" : "App turned off; everyone was disconnected"
      );
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const revoke = useMutation({
    mutationFn: async ({ id, userId }: { id: string; userId: string }) =>
      responseJson(
        await api.api.admin["mcp-clients"][":id"].connections[
          ":userId"
        ].$delete({ param: { id, userId } })
      ),
    onSuccess: async () => {
      toast.success("Disconnected");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const { data } = apps;

  return (
    <TooltipProvider delay={300}>
      <div className="max-w-3xl space-y-6">
        {dialog}
        <div className={adminPanelClass}>
          <label className="flex items-center justify-between gap-4 px-5 py-4">
            <span>
              <span className="block text-[0.8125rem] font-semibold">
                Allow apps to register themselves
              </span>
              <span className="text-muted-foreground mt-0.5 block text-xs leading-5 text-pretty">
                AI agents, editors and mail apps connect by registering
                themselves, then each person approves what they get. When this
                is off, new ones can't connect; apps already connected keep
                working until you turn them off below.
              </span>
            </span>
            <Switch
              checked={data?.allowSelfRegistration ?? true}
              disabled={!data || registration.isPending}
              onCheckedChange={(allowed) => registration.mutate(allowed)}
            />
          </label>
        </div>

        {apps.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-28 rounded-xl" />
            <Skeleton className="h-28 rounded-xl" />
          </div>
        ) : apps.isError ? (
          <div className="border-border bg-surface flex items-center justify-between gap-3 rounded-xl border px-5 py-4">
            <p className="text-destructive text-sm">
              Could not load connected apps.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void apps.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : data?.clients.length ? (
          data.clients.map((app) => (
            <section
              key={app.id}
              className={cn(adminPanelClass, !app.enabled && "opacity-80")}
              aria-label={app.name}
            >
              <AdminPanelHeader
                Icon={Bot}
                title={app.name}
                description={
                  <>
                    <span className="font-mono">
                      {app.host ?? "unknown host"}
                    </span>
                    {" · "}
                    {app.registration === "metadata_document"
                      ? "metadata document"
                      : "registered itself"}
                    {" · added "}
                    {formatDate(app.createdAt)}
                    {" · last used "}
                    {formatDate(app.lastUsedAt)}
                  </>
                }
              >
                {app.enabled ? null : (
                  <Badge className="order-last" variant="destructive">
                    Turned off
                  </Badge>
                )}
              </AdminPanelHeader>
              <AdminPanelBody className="space-y-3">
                {app.connections.length ? (
                  <ul
                    className="divide-border/70 ring-border divide-y rounded-lg ring-1"
                    aria-label={`People who connected ${app.name}`}
                  >
                    {app.connections.map((connection) => (
                      <li
                        key={connection.userId}
                        className="flex flex-col gap-2 px-3.5 py-3 sm:flex-row sm:items-start"
                      >
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <p className="truncate text-sm font-medium">
                            {connection.name}
                          </p>
                          <p className="text-muted-foreground text-[11px]">
                            approved {formatDate(connection.grantedAt)} · last
                            used {formatDate(connection.lastUsedAt)}
                          </p>
                          <ScopeBadges scopes={connection.scopes} />
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="self-start"
                          disabled={revoke.isPending}
                          onClick={async () => {
                            if (
                              await confirm({
                                title: `Disconnect ${connection.name}?`,
                                description: `${app.name} loses access to ${connection.name}'s account at once. They can connect it again.`,
                                action: "Disconnect",
                                destructive: true,
                              })
                            ) {
                              revoke.mutate({
                                id: app.id,
                                userId: connection.userId,
                              });
                            }
                          }}
                        >
                          {revoke.isPending &&
                          revoke.variables?.userId === connection.userId &&
                          revoke.variables.id === app.id ? (
                            <LoaderCircle className="animate-spin" />
                          ) : (
                            <Unplug />
                          )}
                          Disconnect
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    Nobody is connected.
                  </p>
                )}
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant={app.enabled ? "destructive" : "outline"}
                    size="sm"
                    disabled={toggle.isPending}
                    onClick={async () => {
                      if (!app.enabled) {
                        toggle.mutate({ id: app.id, enabled: true });

                        return;
                      }

                      if (
                        await confirm({
                          title: `Turn off ${app.name}?`,
                          description:
                            "Everyone is disconnected at once, and nobody can connect it again until you turn it back on.",
                          action: "Turn off",
                          destructive: true,
                        })
                      ) {
                        toggle.mutate({ id: app.id, enabled: false });
                      }
                    }}
                  >
                    {toggle.isPending && toggle.variables?.id === app.id ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <Power />
                    )}
                    {app.enabled ? "Turn off for everyone" : "Turn on"}
                  </Button>
                </div>
              </AdminPanelBody>
            </section>
          ))
        ) : (
          <div className={adminPanelClass}>
            <AdminListEmpty Icon={Bot} title="No apps have connected yet">
              When anyone in the workspace connects an AI agent or a mail app to
              their account, it shows up here. Each person manages their own
              under Settings → Connected apps.
            </AdminListEmpty>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
