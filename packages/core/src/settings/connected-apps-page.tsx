import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  CalendarClock,
  History,
  LoaderCircle,
  Plug,
  ShieldAlert,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";

import { groupScopes } from "../../shared/oidc";
import type { ScopeInfo } from "../../shared/oidc";
import {
  AdminListEmpty,
  adminPanelClass,
  AdminPanelHeader,
} from "../admin/admin-panel";
import { useAuth } from "../auth/auth-context";
import { formatSessionDate } from "../components/sessions-panel";
import { Button, buttonVariants } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { useConfirm } from "../hooks/use-confirm";
import { api, responseJson } from "../lib/api";
import type { SuccessfulResponse } from "../lib/api";
import { cn } from "../lib/utils";
import { clientModules } from "../modules";

const QUERY_KEY = ["connected-apps"] as const;

type ConnectedApp = SuccessfulResponse<
  Awaited<ReturnType<(typeof api.api.auth)["connected-apps"]["$get"]>>
>["apps"][number];

const fullDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function AppDate({ value }: { value: string | Date }) {
  const date = new Date(value);

  return (
    <time dateTime={date.toISOString()} title={fullDate.format(date)}>
      {formatSessionDate(date)}
    </time>
  );
}

/**
 * An app that asks only for one module's scopes (e.g. a mail app) shows that
 * module's app icon; anything else is an agent or editor.
 */
function appIcon(app: ConnectedApp): LucideIcon {
  const modules = new Set(
    app.scopes
      .filter((scope) => scope.group !== "identity")
      .map((scope) => scope.module)
  );

  const [only] = modules;

  if (modules.size !== 1 || !only) return Bot;

  return (
    clientModules().find((module) => module.name === only)?.app?.Icon ?? Bot
  );
}

/** What the person approved, in plain words, by group (e.g. Mail, People, Administration), Your profile last. */
function GrantedScopes({
  name,
  scopes,
}: {
  name: string;
  scopes: ScopeInfo[];
}) {
  const grouped = groupScopes(scopes);

  const groups = [
    ...grouped.filter(({ group }) => group !== "identity"),
    ...grouped.filter(({ group }) => group === "identity"),
  ];

  if (!groups.length) return null;

  return (
    <dl
      aria-label={`What ${name} may do`}
      className="bg-surface-sunken/60 ring-border/80 mt-3 grid gap-x-4 gap-y-2 rounded-lg px-3.5 py-3 ring-1 @md:grid-cols-[7.5rem_minmax(0,1fr)]"
    >
      {groups.map(({ group, title, scopes: groupedScopes }) => (
        <div key={group} className="contents">
          <dt className="text-muted-foreground pt-px text-xs font-medium">
            {title}
          </dt>
          <dd className="mb-1 last:mb-0 @md:mb-0">
            <ul className="space-y-1">
              {groupedScopes.map((scope) => (
                <li
                  key={scope.id}
                  title={scope.id}
                  className={cn(
                    "flex gap-2 text-[0.8125rem] leading-5 text-pretty",
                    scope.dangerous && "text-destructive font-medium"
                  )}
                >
                  {scope.dangerous ? (
                    <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
                  ) : (
                    <ShieldCheck className="text-success mt-0.5 size-3.5 shrink-0" />
                  )}
                  {scope.label}
                </li>
              ))}
            </ul>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function LoadingRows() {
  return Array.from({ length: 2 }, (_, index) => (
    <div
      key={index}
      className="border-border/70 flex gap-4 border-t px-5 py-4 first:border-t-0"
    >
      <Skeleton className="size-10 rounded-lg" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-3 w-56 max-w-full" />
        <Skeleton className="h-16 w-full rounded-lg" />
      </div>
    </div>
  ));
}

/**
 * Settings → Connected apps: every app the signed-in person approved to use
 * their account (AI agents, editors, mail apps), what each may do, and a way
 * to disconnect it. Administrators see everyone's under Administration.
 */
export function ConnectedAppsSettings() {
  const client = useQueryClient();
  const { user } = useAuth();
  const { confirm, dialog } = useConfirm();

  const apps = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () =>
      responseJson(await api.api.auth["connected-apps"].$get()),
  });

  const disconnect = useMutation({
    mutationFn: async (app: ConnectedApp) =>
      responseJson(
        await api.api.auth["connected-apps"][":clientId"].$delete({
          param: { clientId: app.clientId },
        })
      ),
    onSuccess: async (_, app) => {
      toast.success(`${app.name} disconnected`);
      await client.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error) => toast.error(error.message),
  });

  const items = apps.data?.apps ?? [];

  return (
    <div className="space-y-4">
      {dialog}
      <div className={cn(adminPanelClass, "@container")}>
        <AdminPanelHeader
          Icon={Plug}
          title="Apps you approved"
          description="Each can do only what you allowed."
        />
        {apps.isLoading ? (
          <LoadingRows />
        ) : apps.isError ? (
          <div className="flex items-center justify-between gap-4 px-5 py-6">
            <p className="text-destructive text-sm">
              Your connected apps could not be loaded.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void apps.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : items.length ? (
          <ul aria-label="Connected apps">
            {items.map((app) => {
              const AppIcon = appIcon(app);

              return (
                <li
                  key={app.clientId}
                  aria-label={app.name}
                  className="border-border/70 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 border-t px-5 py-4 first:border-t-0 @md:grid-cols-[auto_minmax(0,1fr)_auto]"
                >
                  <span className="bg-surface-sunken text-muted-foreground ring-border/80 grid size-10 shrink-0 place-items-center rounded-lg ring-1">
                    <AppIcon className="size-4.5" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{app.name}</p>
                    {app.host ? (
                      <p className="text-muted-foreground truncate font-mono text-[0.6875rem]">
                        {app.host}
                      </p>
                    ) : null}
                    <div className="text-muted-foreground mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <CalendarClock className="size-3.5 shrink-0" />
                        Connected <AppDate value={app.grantedAt} />
                      </span>
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <History className="size-3.5 shrink-0" />
                        {app.lastUsedAt ? (
                          <>
                            Last used <AppDate value={app.lastUsedAt} />
                          </>
                        ) : (
                          "Not used yet"
                        )}
                      </span>
                    </div>
                    <GrantedScopes name={app.name} scopes={app.scopes} />
                  </div>
                  {/* Narrow: under the details. Wide: its own column. */}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="col-start-2 mt-3 justify-self-start @md:col-start-3 @md:row-start-1 @md:mt-0.5"
                    aria-label={`Disconnect ${app.name}`}
                    disabled={disconnect.isPending}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: `Disconnect ${app.name}?`,
                          description: `${app.name} loses access to your account at once. To use it again, connect it and approve it again.`,
                          action: "Disconnect",
                          destructive: true,
                        })
                      ) {
                        disconnect.mutate(app);
                      }
                    }}
                  >
                    {disconnect.isPending &&
                    disconnect.variables?.clientId === app.clientId ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <Unplug />
                    )}
                    Disconnect
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <AdminListEmpty Icon={Plug} title="No apps connected">
            When you let an AI agent, an editor or a mail app use your account,
            it shows up here, and you can disconnect it at any time.
            <Link
              to="/settings/mcp"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "mx-auto mt-4 flex w-fit"
              )}
            >
              <Bot /> Connect an AI agent
            </Link>
          </AdminListEmpty>
        )}
      </div>

      {user?.role === "admin" ? (
        <p className="text-muted-foreground px-1 text-xs leading-5 text-pretty">
          Only your own approvals are listed. Apps connected by anyone in the
          workspace are under{" "}
          <Link
            to="/admin/connected-apps"
            className="text-foreground font-medium underline-offset-4 hover:underline"
          >
            Administration → Connected apps
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}
