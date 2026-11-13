import {
  CalendarClock,
  LoaderCircle,
  MapPin,
  Monitor,
  Network,
  ShieldCheck,
  Smartphone,
  X,
} from "lucide-react";
import { useState } from "react";

import { adminPanelClass, AdminPanelHeader } from "../admin/admin-panel";
import { formatSessionLocation } from "../lib/session-location";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";

export type SessionRecord = {
  id: string;
  userAgent: string | null;
  location: string | null;
  ipAddress: string | null;
  createdAt: string | Date;
  expiresAt: string | Date;
  isCurrent: boolean;
};

const fullDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** A date short enough for one line on a phone: the year only when it isn't this one. */
export function formatSessionDate(
  value: string | Date,
  { time = true, now = new Date() } = {}
) {
  const date = new Date(value);

  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
  };

  if (date.getFullYear() !== now.getFullYear()) options.year = "numeric";

  if (time) {
    options.hour = "numeric";
    options.minute = "2-digit";
  }

  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function SessionDate({
  value,
  time,
}: {
  value: string | Date;
  time?: boolean;
}) {
  const date = new Date(value);

  return (
    <time dateTime={date.toISOString()} title={fullDate.format(date)}>
      {formatSessionDate(date, { time })}
    </time>
  );
}

function sessionDevice(userAgent: string | null) {
  if (!userAgent) return { label: "Unknown device", mobile: false };
  const mobile = /Android|iPhone|iPad|Mobile/u.test(userAgent);

  const browser = /Edg(?:e|A|iOS)?\//u.test(userAgent)
    ? "Edge"
    : /(?:Chrome|CriOS)\//u.test(userAgent)
      ? "Chrome"
      : /(?:Firefox|FxiOS)\//u.test(userAgent)
        ? "Firefox"
        : /Safari\//u.test(userAgent)
          ? "Safari"
          : "Browser";

  const platform = /iPhone/u.test(userAgent)
    ? "iPhone"
    : /iPad/u.test(userAgent)
      ? "iPad"
      : /Android/u.test(userAgent)
        ? "Android"
        : /Windows/u.test(userAgent)
          ? "Windows"
          : /Macintosh|Mac OS X/u.test(userAgent)
            ? "macOS"
            : /Linux/u.test(userAgent)
              ? "Linux"
              : "unknown OS";

  return { label: `${browser} on ${platform}`, mobile };
}

function LoadingRows() {
  return Array.from({ length: 2 }, (_, index) => (
    <div
      key={index}
      className="border-border/70 flex items-center gap-4 border-t px-5 py-4 first:border-t-0"
    >
      <Skeleton className="size-10 rounded-lg" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-64 max-w-full" />
      </div>
    </div>
  ));
}

export function SessionsPanel({
  title = "Sessions",
  description = "Active sign-ins",
  sessions,
  loading,
  error,
  pendingSessionId,
  onRetry,
  onRevoke,
}: {
  title?: string;
  description?: string;
  sessions?: SessionRecord[];
  loading: boolean;
  error: boolean;
  pendingSessionId?: string;
  onRetry: () => void;
  onRevoke: (session: SessionRecord) => void;
}) {
  const [confirmation, setConfirmation] = useState<SessionRecord | null>(null);
  const [confirmationOpen, setConfirmationOpen] = useState(false);

  return (
    <>
      <div className={`${adminPanelClass} @container`}>
        <AdminPanelHeader
          Icon={ShieldCheck}
          title={title}
          description={description}
        />
        {loading ? (
          <LoadingRows />
        ) : error ? (
          <div className="flex items-center justify-between gap-4 px-5 py-6">
            <p className="text-destructive text-sm">Sessions unavailable</p>
            <Button size="sm" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          </div>
        ) : sessions?.length ? (
          sessions.map((record) => {
            const device = sessionDevice(record.userAgent);
            const DeviceIcon = device.mobile ? Smartphone : Monitor;

            return (
              <div
                key={record.id}
                className="border-border/70 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 border-t px-5 py-4 first:border-t-0 @md:grid-cols-[auto_minmax(0,1fr)_auto]"
              >
                <span className="bg-surface-sunken text-muted-foreground ring-border/80 grid size-10 shrink-0 place-items-center rounded-lg ring-1">
                  <DeviceIcon className="size-4.5" />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p
                      className="font-medium"
                      title={record.userAgent ?? undefined}
                    >
                      {device.label}
                    </p>
                    {record.isCurrent ? (
                      <Badge variant="success">Current</Badge>
                    ) : null}
                  </div>
                  <div className="text-muted-foreground mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <MapPin className="size-3.5 shrink-0" />{" "}
                      {formatSessionLocation(record.location)}
                    </span>
                    {record.ipAddress ? (
                      <span className="inline-flex min-w-0 items-center gap-1.5 break-all">
                        <Network className="size-3.5 shrink-0" />{" "}
                        {record.ipAddress}
                      </span>
                    ) : null}
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                      <CalendarClock className="size-3.5 shrink-0" />
                      Signed in <SessionDate value={record.createdAt} />
                    </span>
                  </div>
                  <p className="text-muted-foreground/75 mt-1 text-[11px] whitespace-nowrap">
                    Expires{" "}
                    <SessionDate value={record.expiresAt} time={false} />
                  </p>
                </div>
                {/* Narrow: under the details, so they keep the row's width. Wide: its own column. */}
                <Button
                  type="button"
                  className="col-start-2 mt-3 justify-self-start @md:col-start-3 @md:row-start-1 @md:mt-0.5"
                  size="sm"
                  variant="destructive"
                  aria-label={`Revoke ${device.label}${record.isCurrent ? " (this session)" : ""}`}
                  disabled={Boolean(pendingSessionId)}
                  onClick={() => {
                    setConfirmation(record);
                    setConfirmationOpen(true);
                  }}
                >
                  {pendingSessionId === record.id ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <X />
                  )}
                  Revoke
                </Button>
              </div>
            );
          })
        ) : (
          <p className="text-muted-foreground px-5 py-8 text-center text-sm">
            No active sessions
          </p>
        )}
      </div>

      <AlertDialog
        open={confirmationOpen}
        onOpenChange={setConfirmationOpen}
        onOpenChangeComplete={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke session?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation?.isCurrent
                ? "You will be signed out."
                : "This sign-in will be revoked."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              onClick={() => {
                const session = confirmation;
                setConfirmationOpen(false);

                if (session) onRevoke(session);
              }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
