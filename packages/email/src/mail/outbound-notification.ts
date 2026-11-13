import { toast } from "sonner";

import type { TransportState } from "./types";

type OutboundResult = {
  transportState: Exclude<TransportState, "received">;
  transportError?: string | null;
  externalizedAttachments?: number;
  detached?: boolean;
};

export function notifyOutboundResult(
  result: OutboundResult,
  kind: "message" | "reply"
) {
  const label = kind === "reply" ? "Reply" : "Message";

  if (result.transportState === "failed") {
    toast.error(
      result.transportError || `${label} could not be prepared for sending`
    );

    return;
  }

  if (result.transportState === "unconfirmed") {
    toast.warning(
      result.transportError
        ? `${result.transportError} Submission was not confirmed.`
        : "Submission was not confirmed; automatic resend is disabled"
    );

    return;
  }

  if (result.externalizedAttachments) {
    toast.success(
      `${result.externalizedAttachments} large attachment${
        result.externalizedAttachments === 1 ? "" : "s"
      } sent as 30-day download links`
    );

    return;
  }

  toast.success(
    kind === "reply"
      ? result.detached
        ? "Private reply sent"
        : "Reply sent"
      : "Message sent"
  );
}
