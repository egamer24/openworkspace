import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
  AdminPanelHeader,
  Button,
  Switch,
  useAuth,
  responseJson,
} from "@open-workspace/core/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, LoaderCircle, Smartphone } from "lucide-react";
import { toast } from "sonner";

import { mailApi } from "../lib/mail-api";
import {
  currentPushRegistrationStatus,
  disableCurrentPushSubscription,
  enableCurrentPushSubscription,
} from "../pwa/push-subscription";

type DeviceStatus =
  | "loading"
  | "error"
  | "unsupported"
  | "prompt"
  | "denied"
  | "enabled";

function deviceStatusCopy(
  status: DeviceStatus,
  configured: boolean,
  configurationError: string | null
) {
  if (status === "error") return "Could not check this device. Try again.";

  if (configurationError) return configurationError;

  if (!configured) return "Web Push is not configured on this server.";

  if (status === "unsupported") {
    return "Push is unavailable in this browser. On iPhone or iPad, add the app to the Home Screen first.";
  }

  if (status === "denied") {
    return "Notifications are blocked in this browser's site settings.";
  }

  if (status === "enabled") {
    return "This device can notify you when OpenWorkspace is closed.";
  }

  if (status === "prompt") {
    return "Enable notifications for this browser and device.";
  }

  return "Checking this device…";
}

export function NotificationsSettings() {
  const client = useQueryClient();
  const userId = useAuth().user?.id;

  const config = useQuery({
    queryKey: ["push-config"],
    queryFn: async () =>
      responseJson(await mailApi.api.notifications.config.$get()),
    staleTime: 60_000,
  });

  const preferences = useQuery({
    queryKey: ["notification-preferences"],
    queryFn: async () =>
      responseJson(await mailApi.api.notifications.preferences.$get()),
  });

  const publicKey = config.data?.publicKey ?? null;
  const deviceStatusKey = ["push-device-status", userId, publicKey] as const;

  const device = useQuery({
    queryKey: deviceStatusKey,
    enabled: Boolean(config.data?.enabled && publicKey && userId),
    queryFn: () => currentPushRegistrationStatus(),
  });

  const enable = useMutation({
    mutationFn: async () => {
      if (!publicKey) throw new Error("Web Push is not configured");

      if (!userId) throw new Error("Sign in is required");
      await enableCurrentPushSubscription(publicKey);
    },
    onSuccess: () => {
      client.setQueryData(deviceStatusKey, "enabled" satisfies DeviceStatus);
      toast.success("Notifications enabled on this device");
    },
    onError: (error) => {
      void client.invalidateQueries({ queryKey: deviceStatusKey });
      toast.error(error.message);
    },
  });

  const disable = useMutation({
    mutationFn: disableCurrentPushSubscription,
    onSuccess: (removal) => {
      client.setQueryData(deviceStatusKey, "prompt" satisfies DeviceStatus);

      if (removal.browserUnsubscribed) {
        toast.success("Notifications disabled on this device");
      } else {
        toast.warning(
          "Notifications are disabled; this browser kept an unused subscription."
        );
      }
    },
    onError: (error) => toast.error(error.message),
  });

  const updatePreference = useMutation({
    mutationFn: async ({
      mailboxId,
      enabled,
    }: {
      mailboxId: string;
      enabled: boolean;
    }) =>
      responseJson(
        await mailApi.api.notifications.preferences[":mailboxId"].$put({
          param: { mailboxId },
          json: { enabled },
        })
      ),
    onSuccess: async () => {
      await client.invalidateQueries({
        queryKey: ["notification-preferences"],
      });
    },
    onError: (error) => toast.error(error.message),
  });

  const configured = config.data?.enabled ?? false;

  const deviceStatus: DeviceStatus =
    config.isError || device.isError
      ? "error"
      : config.isLoading || (configured && device.isLoading)
        ? "loading"
        : configured
          ? (device.data ?? "loading")
          : "unsupported";

  const devicePending =
    config.isLoading ||
    device.isFetching ||
    enable.isPending ||
    disable.isPending;

  function handleDeviceAction() {
    if (deviceStatus === "error") {
      void (config.isError ? config.refetch() : device.refetch());

      return;
    }

    enable.mutate();
  }

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={Bell}
        title="Mail notifications"
        description="Alerts for new mail, set for you on this device."
      />
      <AdminPanelBody className="space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <span className="bg-primary/12 text-primary grid size-11 shrink-0 place-items-center rounded-lg">
            <Smartphone className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">This device</p>
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
              {deviceStatusCopy(
                deviceStatus,
                configured,
                config.data?.error ?? null
              )}
            </p>
          </div>
          {deviceStatus === "enabled" ? (
            <Button
              variant="outline"
              disabled={devicePending}
              onClick={() => disable.mutate()}
            >
              {disable.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <BellOff />
              )}
              Disable
            </Button>
          ) : (
            <Button
              disabled={
                (deviceStatus !== "error" && !configured) ||
                deviceStatus === "unsupported" ||
                deviceStatus === "denied" ||
                deviceStatus === "loading" ||
                devicePending
              }
              onClick={handleDeviceAction}
            >
              {devicePending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Bell />
              )}
              {deviceStatus === "error" ? "Retry" : "Enable"}
            </Button>
          )}
        </div>

        <div className="border-border/70 border-t pt-5">
          <p className="text-sm font-semibold">Mailboxes</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Choose which mailboxes may send you new-message notifications.
          </p>
          <div className="divide-border/70 mt-4 divide-y">
            {preferences.isLoading ? (
              <div className="text-muted-foreground flex items-center gap-2 py-4 text-xs">
                <LoaderCircle className="size-4 animate-spin" /> Loading
                mailboxes…
              </div>
            ) : preferences.isError ? (
              <div className="flex items-center justify-between gap-4 py-4">
                <p className="text-destructive text-xs">
                  Could not load mailbox preferences.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={preferences.isFetching}
                  onClick={() => void preferences.refetch()}
                >
                  {preferences.isFetching && (
                    <LoaderCircle className="animate-spin" />
                  )}
                  Retry
                </Button>
              </div>
            ) : preferences.data?.preferences.length ? (
              preferences.data.preferences.map((preference) => (
                <label
                  key={preference.mailboxId}
                  className="flex items-center gap-4 py-3"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {preference.displayName}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {preference.address}
                    </span>
                  </span>
                  <Switch
                    checked={preference.enabled}
                    disabled={updatePreference.isPending}
                    onCheckedChange={(enabled) =>
                      updatePreference.mutate({
                        mailboxId: preference.mailboxId,
                        enabled,
                      })
                    }
                  />
                </label>
              ))
            ) : (
              <p className="text-muted-foreground py-4 text-xs">
                No mailboxes are available for notifications.
              </p>
            )}
          </div>
        </div>
      </AdminPanelBody>
      <AdminPanelFooter className="text-muted-foreground justify-start text-xs">
        You won't be notified about a mailbox while it's open in a tab.
      </AdminPanelFooter>
    </div>
  );
}
