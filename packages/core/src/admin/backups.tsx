import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DatabaseBackup, LoaderCircle, Play } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { api, responseJson } from "../lib/api";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "./admin-panel";

const BACKUPS_KEY = ["admin-backups"] as const;

function formatTime(value: number) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Administration → Backups: the latest daily snapshot, and Run now. */
export function Backups() {
  const client = useQueryClient();

  const status = useQuery({
    queryKey: BACKUPS_KEY,
    queryFn: async () => responseJson(await api.api.admin.backups.$get()),
    // While a snapshot runs, show it moving.
    refetchInterval: (query) =>
      query.state.data?.latest?.status === "running" ? 5000 : false,
  });

  const run = useMutation({
    mutationFn: async () =>
      responseJson(await api.api.admin.backups.run.$post()),
    onSuccess: async () => {
      toast.success("Backup started");
      await client.invalidateQueries({ queryKey: BACKUPS_KEY });
    },
    onError: (error) => toast.error(error.message),
  });

  const { data } = status;
  const latest = data?.latest;

  return (
    <div className="max-w-4xl">
      <div className={adminPanelClass}>
        <AdminPanelHeader
          Icon={DatabaseBackup}
          title="Daily backups"
          description="A snapshot of the workspace and each app's data, once a day."
        />
        <AdminPanelBody className="space-y-4">
          {status.isLoading ? (
            <Skeleton className="h-20" />
          ) : data?.enabled ? (
            <>
              {latest ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
                  <dt className="text-muted-foreground">Snapshot</dt>
                  <dd className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{latest.id}</span>
                    <Badge
                      variant={
                        latest.status === "running" ? "secondary" : "outline"
                      }
                    >
                      {latest.status === "running" ? "Running" : "Completed"}
                    </Badge>
                  </dd>
                  <dt className="text-muted-foreground">Started</dt>
                  <dd>{formatTime(latest.startedAt)}</dd>
                  {latest.finishedAt === null ? (
                    latest.module && (
                      <>
                        <dt className="text-muted-foreground">Now copying</dt>
                        <dd className="truncate">{latest.module}</dd>
                      </>
                    )
                  ) : (
                    <>
                      <dt className="text-muted-foreground">Finished</dt>
                      <dd>{formatTime(latest.finishedAt)}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">Items</dt>
                  <dd>
                    {latest.itemCount} ({latest.newObjectCount} new,{" "}
                    {formatBytes(latest.newObjectBytes)})
                  </dd>
                </dl>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No backup yet. The first one starts within the hour.
                </p>
              )}
              <p className="text-muted-foreground text-sm">
                The newest snapshot of each of the last {data.keepDays} days and{" "}
                {data.keepWeeks} weeks is kept.
              </p>
              {latest?.errors.length ? (
                <div className="space-y-1">
                  <p className="text-sm font-medium">Problems</p>
                  <ul className="text-muted-foreground list-disc space-y-0.5 pl-5 text-xs">
                    {latest.errors.map((error) => (
                      <li key={error} className="break-all">
                        {error}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <Button
                variant="outline"
                disabled={run.isPending || latest?.status === "running"}
                onClick={() => run.mutate()}
              >
                {run.isPending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Play />
                )}
                Run now
              </Button>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              Backups are off. Deploy with{" "}
              <code className="text-foreground">
                {"OpenWorkspace({ backups: {} })"}
              </code>{" "}
              to copy the workspace to a bucket of its own each day.
            </p>
          )}
        </AdminPanelBody>
      </div>
    </div>
  );
}
