import { cn } from "@open-workspace/core/ui";
import { CornerUpLeft } from "lucide-react";

import type { MessageDetail } from "./types";

/**
 * A calm note when replies would reach another organization than the one in
 * From (a common invoice-fraud pattern). Shown only while that address is a
 * recipient.
 */
export function ReplyToWarning({
  message,
  recipients,
  className,
}: {
  message: Pick<MessageDetail, "fromAddress" | "security">;
  recipients: readonly string[];
  className?: string;
}) {
  const mismatch = message.security?.replyToMismatch;

  if (
    !mismatch ||
    !recipients.some((address) => address.toLowerCase() === mismatch.address)
  ) {
    return null;
  }

  const fromDomain =
    message.security?.fromDomain ?? message.fromAddress.split("@").at(-1);

  return (
    <p
      role="note"
      data-testid="reply-to-warning"
      className={cn(
        "bg-warning/10 text-foreground flex items-start gap-2 px-3.5 py-2 text-xs leading-5",
        className
      )}
    >
      <CornerUpLeft className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
      <span>
        Replies go to <span className="font-medium">{mismatch.address}</span>,
        not the sender's domain
        {fromDomain ? <> ({fromDomain})</> : null}. Check the address before
        sending anything sensitive.
      </span>
    </p>
  );
}
