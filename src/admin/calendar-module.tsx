import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarDays } from "lucide-react";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, responseJson } from "@/lib/api";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "./admin-panel";

export function CalendarModule({
  enabled,
  loading,
}: {
  enabled: boolean;
  loading: boolean;
}) {
  const client = useQueryClient();
  const update = useMutation({
    mutationFn: async (nextEnabled: boolean) => responseJson(
      await api.api.admin.calendar.$put({ json: { enabled: nextEnabled } }),
    ),
    onSuccess: async (result) => {
      toast.success(result.enabled ? "Calendar enabled" : "Calendar disabled");
      await Promise.all([
        client.invalidateQueries({ queryKey: ["admin-state"] }),
        client.invalidateQueries({ queryKey: ["auth-state"] }),
      ]);
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={CalendarDays}
        title="Calendar"
        description="Optional module for every member of this workspace"
      />
      <AdminPanelBody className="flex items-center justify-between gap-6">
        <div>
          <p className="text-sm font-medium">Enable calendars</p>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
            Personal calendars with reminders, ICS feeds, import and MCP tools. When off,
            calendar routes, feeds, reminders and navigation are unavailable; stored events are kept.
          </p>
        </div>
        {loading ? (
          <Skeleton className="h-6 w-10 shrink-0 rounded-full" />
        ) : (
          <Switch
            aria-label="Enable calendars"
            checked={enabled}
            disabled={update.isPending}
            onCheckedChange={(checked) => update.mutate(checked)}
          />
        )}
      </AdminPanelBody>
    </div>
  );
}
