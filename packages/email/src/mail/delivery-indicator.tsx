import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  cn,
} from "@open-workspace/core/ui";
import { format } from "date-fns";
import { Check, CheckCheck, CircleAlert, Clock3 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { MessageDetail, RecipientDeliveryStatus } from "./types";

type Indicator = {
  Icon: LucideIcon;
  label: string;
  tone: "muted" | "warning" | "danger";
};

function recipients(message: MessageDetail) {
  return [
    ...new Set(
      [
        ...message.toAddresses,
        ...message.ccAddresses,
        ...message.bccAddresses,
      ].map((address) => address.trim().toLocaleLowerCase())
    ),
  ];
}

function deliveryIndicator(
  message: MessageDetail,
  totalRecipients: number
): Indicator {
  if (message.transportState === "unconfirmed") {
    return { Icon: CircleAlert, label: "Unconfirmed", tone: "warning" };
  }

  if (message.transportState === "failed") {
    return { Icon: CircleAlert, label: "Not sent", tone: "danger" };
  }

  if (!message.deliveryStatuses.length) {
    return { Icon: Check, label: "Sent", tone: "muted" };
  }

  const delivered = message.deliveryStatuses.filter(
    (item) => item.status === "delivered" || item.status === "complained"
  ).length;

  const failed = message.deliveryStatuses.filter((item) =>
    ["bounced", "failed", "rejected"].includes(item.status)
  ).length;

  const complained = message.deliveryStatuses.some(
    (item) => item.status === "complained"
  );

  if (failed > 0 || complained) {
    return {
      Icon: CircleAlert,
      label:
        delivered > 0 && totalRecipients > 1
          ? `${delivered}/${totalRecipients} delivered`
          : failed > 0
            ? "Not delivered"
            : "Marked as spam",
      tone: delivered > 0 ? "warning" : "danger",
    };
  }

  if (totalRecipients > 0 && delivered >= totalRecipients) {
    return { Icon: CheckCheck, label: "Delivered", tone: "muted" };
  }

  return {
    Icon: Clock3,
    label:
      delivered > 0 && totalRecipients > 1
        ? `${delivered}/${totalRecipients} delivered`
        : "Delivering",
    tone: "muted",
  };
}

const recipientStatusIcons: Record<
  RecipientDeliveryStatus["status"],
  { Icon: LucideIcon; className: string }
> = {
  delivered: { Icon: CheckCheck, className: "text-success" },
  deferred: { Icon: Clock3, className: "text-amber-600 dark:text-amber-400" },
  bounced: { Icon: CircleAlert, className: "text-destructive" },
  failed: { Icon: CircleAlert, className: "text-destructive" },
  rejected: { Icon: CircleAlert, className: "text-destructive" },
  complained: {
    Icon: CircleAlert,
    className: "text-amber-600 dark:text-amber-400",
  },
};

/** Plain-language outcome; the SMTP detail stays available underneath. */
function recipientExplanation(status: RecipientDeliveryStatus | undefined) {
  if (!status) {
    return "Sent. Waiting for the recipient's server to report back.";
  }

  if (status.status === "delivered") {
    return "Accepted by the recipient's mail server.";
  }

  if (status.status === "deferred") {
    return "The recipient's server asked to try later. Delivery is retried automatically.";
  }

  if (status.status === "bounced") {
    return "The recipient's server refused the message permanently.";
  }

  if (status.status === "failed") return "The message could not be delivered.";

  if (status.status === "rejected") return "Rejected before delivery.";

  return "Delivered, but the recipient reported it as spam.";
}

function smtpCodeMeaning(code: string) {
  if (code.startsWith("2")) return "OK";

  if (code.startsWith("4")) return "temporary failure";

  if (code.startsWith("5")) return "permanent failure";

  return null;
}

function recipientStatusLabel(status: RecipientDeliveryStatus | undefined) {
  if (!status) return "Awaiting status";

  if (status.status === "delivered") return "Delivered";

  if (status.status === "deferred") return "Delivery delayed";

  if (status.status === "bounced") return "Bounced";

  if (status.status === "failed") return "Delivery failed";

  if (status.status === "rejected") return "Rejected";

  return "Marked as spam";
}

export function DeliveryIndicator({
  message,
  className,
}: {
  message: MessageDetail;
  className?: string;
}) {
  if (message.direction !== "outgoing") return null;
  const addresses = recipients(message);

  const statuses = new Map(
    message.deliveryStatuses.map((status) => [
      status.recipient.toLocaleLowerCase(),
      status,
    ])
  );

  const indicator = deliveryIndicator(message, addresses.length);
  const { Icon } = indicator;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className={cn(
              "focus-visible:ring-ring inline-flex items-center gap-1 rounded-sm text-xs font-medium transition-opacity outline-none hover:opacity-75 focus-visible:ring-2",
              indicator.tone === "muted" && "text-muted-foreground",
              indicator.tone === "warning" &&
                "text-amber-700 dark:text-amber-400",
              indicator.tone === "danger" && "text-destructive",
              className
            )}
            aria-label={`Delivery status: ${indicator.label}`}
          />
        }
      >
        <Icon
          className={cn(
            "size-3.5",
            indicator.Icon === CheckCheck && "text-success"
          )}
        />
        <span>{indicator.label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-80 max-w-[calc(100vw-2rem)]"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>Delivery status</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {message.transportState === "unconfirmed" ? (
          <p className="px-2 py-2 text-xs text-amber-700 dark:text-amber-400">
            {message.transportError
              ? `${message.transportError} Submission could not be confirmed.`
              : "Submission could not be confirmed."}{" "}
            Automatic resend is disabled because it could deliver a duplicate.
          </p>
        ) : message.transportState === "failed" ? (
          <p className="text-destructive px-2 py-2 text-xs">
            {message.transportError ||
              "The message could not be prepared for sending."}
          </p>
        ) : (
          <div className="divide-y">
            {addresses.map((address) => {
              const status = statuses.get(address);

              const { Icon: StatusIcon, className: iconClassName } = status
                ? recipientStatusIcons[status.status]
                : { Icon: Clock3, className: "text-muted-foreground" };

              const meaning = status?.smtpCode
                ? smtpCodeMeaning(status.smtpCode)
                : null;

              return (
                <div key={address} className="flex gap-2.5 px-2 py-2.5 text-xs">
                  <StatusIcon
                    className={cn("mt-0.5 size-3.5 shrink-0", iconClassName)}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate font-medium">
                        {address}
                      </span>
                      <span className="text-muted-foreground shrink-0">
                        {recipientStatusLabel(status)}
                      </span>
                    </p>
                    <p className="text-muted-foreground mt-0.5">
                      {recipientExplanation(status)}
                    </p>
                    {status && (
                      <p className="text-muted-foreground/80 mt-1 text-[11px]">
                        {[
                          status.smtpCode &&
                            `SMTP ${status.smtpCode}${meaning ? ` (${meaning})` : ""}`,
                          status.detail,
                          format(new Date(status.eventAt), "MMM d 'at' HH:mm"),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
