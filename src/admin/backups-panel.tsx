import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, LoaderCircle, Play } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, responseJson } from "@/lib/api";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
  AdminPanelHeader,
} from "./admin-panel";

const backupsQueryKey = ["admin-backups"];

function formatDate(value: number | null) {
  if (!value) return "Not finished";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatBytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

export function BackupsPanel() {
  const client = useQueryClient();
  const status = useQuery({
    queryKey: backupsQueryKey,
    queryFn: async () => responseJson(await api.api.admin.backups.$get()),
    refetchInterval: (query) =>
      query.state.data?.latest?.status === "running" ? 10_000 : false,
  });
  const runNow = useMutation({
    mutationFn: async () => responseJson(await api.api.admin.backups.run.$post()),
    onSuccess: async () => {
      toast.success("Backup started");
      await client.invalidateQueries({ queryKey: backupsQueryKey });
    },
    onError: (error) => toast.error(error.message),
  });
  const latest = status.data?.latest;
  const running = latest?.status === "running";

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={Archive}
        title="Scheduled backups"
        description="Daily .eml and manifest snapshots in a separate R2 bucket"
      />
      <AdminPanelBody>
        {status.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : !status.data?.enabled ? (
          <p className="text-sm text-muted-foreground">
            Backups are disabled. Create a separate R2 bucket and bind it as{" "}
            <code>BACKUP_STORAGE</code> in <code>wrangler.jsonc</code>.
          </p>
        ) : !latest ? (
          <p className="text-sm text-muted-foreground">No backup has run yet.</p>
        ) : (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Snapshot</dt>
              <dd className="mt-0.5 flex items-center gap-2 font-medium">
                {latest.id}
                <Badge variant={running ? "info" : "success"}>
                  {running ? "Running" : "Completed"}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {running ? "Started" : "Finished"}
              </dt>
              <dd className="mt-0.5 font-medium">
                {formatDate(running ? latest.startedAt : latest.finishedAt)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Messages</dt>
              <dd className="mt-0.5 font-medium">
                {latest.messageCount.toLocaleString()}
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  ({latest.newObjectCount.toLocaleString()} new)
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Size</dt>
              <dd className="mt-0.5 font-medium">{formatBytes(latest.byteCount)}</dd>
            </div>
            {running && latest.currentMailbox ? (
              <div className="col-span-full">
                <dt className="text-xs text-muted-foreground">Current mailbox</dt>
                <dd className="mt-0.5 font-medium">{latest.currentMailbox}</dd>
              </div>
            ) : null}
            {latest.errors.length ? (
              <div className="col-span-full">
                <dt className="text-xs text-muted-foreground">
                  Errors ({latest.errors.length})
                </dt>
                <dd className="mt-1 max-h-40 overflow-auto rounded-md bg-surface-sunken p-2 font-mono text-xs leading-relaxed">
                  {latest.errors.map((error, index) => <p key={index}>{error}</p>)}
                </dd>
              </div>
            ) : null}
          </dl>
        )}
      </AdminPanelBody>
      {status.data?.enabled ? (
        <AdminPanelFooter>
          <Button
            size="sm"
            disabled={running || runNow.isPending}
            onClick={() => runNow.mutate()}
          >
            {runNow.isPending ? <LoaderCircle className="animate-spin" /> : <Play />}
            Run now
          </Button>
        </AdminPanelFooter>
      ) : null}
    </div>
  );
}
