import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, responseJson } from "@/lib/api";
import { formatBytes } from "@/mail/format-bytes";
import { adminPanelClass, AdminPanelBody, AdminPanelHeader } from "./admin-panel";

const GB = 1_000_000_000;

export function DriveSettings() {
  const client = useQueryClient();
  const state = useQuery({
    queryKey: ["admin-drive"],
    queryFn: async () => responseJson(await api.api.admin.drive.$get()),
  });
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["admin-drive"] });
    await client.invalidateQueries({ queryKey: ["drive-status"] });
  };
  const toggle = useMutation({
    mutationFn: async (enabled: boolean) =>
      responseJson(await api.api.admin.drive.$put({ json: { enabled } })),
    onSuccess: async (result) => {
      toast.success(result.enabled ? "Drive enabled" : "Drive disabled");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const quota = useMutation({
    mutationFn: async (input: { userId: string; quotaBytes: number | null }) =>
      responseJson(await api.api.admin.drive.quotas[":userId"].$put({
        param: { userId: input.userId },
        json: { quotaBytes: input.quotaBytes },
      })),
    onSuccess: async () => {
      toast.success("Quota updated");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={HardDrive}
        title="Drive"
        description="Optional file storage with sharing and public links"
      />
      <AdminPanelBody className="space-y-6">
        <div className="flex items-center justify-between gap-6">
          <div>
            <p className="text-sm font-medium">Enable Drive</p>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
              Off by default. While off, Drive pages, API routes, public links and MCP tools are unavailable; stored files are kept.
            </p>
          </div>
          {state.isLoading ? (
            <Skeleton className="h-6 w-10 shrink-0 rounded-full" />
          ) : (
            <Switch
              aria-label="Enable Drive"
              checked={state.data?.enabled ?? false}
              disabled={toggle.isPending}
              onCheckedChange={(checked) => toggle.mutate(checked)}
            />
          )}
        </div>
        {state.data && (
          <div>
            <p className="text-sm font-medium">Storage quotas</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Default {formatBytes(state.data.defaultQuotaBytes)} per person. Trash counts until it is emptied.
            </p>
            <ul className="mt-3 divide-y rounded-md border">
              {state.data.quotas.map((row) => (
                <QuotaRow
                  key={row.userId}
                  name={row.name}
                  usedBytes={row.usedBytes}
                  quotaBytes={row.quotaBytes}
                  defaultQuotaBytes={state.data.defaultQuotaBytes}
                  pending={quota.isPending}
                  onSave={(quotaBytes) => quota.mutate({ userId: row.userId, quotaBytes })}
                />
              ))}
            </ul>
          </div>
        )}
      </AdminPanelBody>
    </div>
  );
}

function QuotaRow({ name, usedBytes, quotaBytes, defaultQuotaBytes, pending, onSave }: {
  name: string;
  usedBytes: number;
  quotaBytes: number | null;
  defaultQuotaBytes: number;
  pending: boolean;
  onSave: (quotaBytes: number | null) => void;
}) {
  const [value, setValue] = useState(quotaBytes === null ? "" : String(quotaBytes / GB));
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {formatBytes(usedBytes)} of {formatBytes(quotaBytes ?? defaultQuotaBytes)}
      </span>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = value.trim();
          onSave(trimmed === "" ? null : Math.round(Number(trimmed) * GB));
        }}
      >
        <Input
          aria-label={`Quota for ${name} in GB`}
          className="h-8 w-24"
          type="number"
          min="0"
          step="any"
          placeholder="Default"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <span className="text-xs text-muted-foreground">GB</span>
        <Button size="sm" variant="outline" type="submit" disabled={pending}>Save</Button>
      </form>
    </li>
  );
}
