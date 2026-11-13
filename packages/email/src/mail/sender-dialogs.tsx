import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Checkbox,
  RadioCard,
  RadioGroup,
  cn,
} from "@open-workspace/core/ui";
import { ExternalLink, LoaderCircle, MailMinus, ShieldBan } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import type { Mailbox, MessageDetail } from "./types";
import { useBlockSender, useUnsubscribe } from "./use-mail-safety";

export function senderLabel(
  message: Pick<MessageDetail, "fromName" | "fromAddress">
) {
  return message.fromName || message.fromAddress;
}

export function addressDomain(address: string) {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

function urlHost(url: string | null | undefined) {
  if (!url) return null;

  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function mailtoAddress(uri: string | null | undefined) {
  if (!uri) return null;

  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return null;
  }
}

function CheckRow({
  checked,
  disabled,
  onChange,
  children,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-2.5 text-[13px] leading-5",
        disabled && "opacity-60"
      )}
    >
      <Checkbox
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
      <span className="min-w-0">
        <span className="text-foreground font-medium">{children}</span>
        {hint && (
          <span className="text-muted-foreground block text-xs">{hint}</span>
        )}
      </span>
    </label>
  );
}

/** The sender's unsubscribe page, opened only by an explicit click, without a referrer. */
function UnsubscribePageLink({
  url,
  onOpen,
}: {
  url: string;
  onOpen: () => void;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      onClick={onOpen}
      className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring/40 inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium outline-none focus-visible:ring-3"
    >
      <ExternalLink className="size-4" /> Open unsubscribe page
    </a>
  );
}

export function UnsubscribeDialog({
  message,
  mailbox,
  open,
  onOpenChange,
}: {
  message: MessageDetail;
  mailbox: Mailbox;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const methods = message.security?.listUnsubscribe;
  const unsubscribe = useUnsubscribe();

  const [fallback, setFallback] = useState<{
    url: string;
    detail: string | null;
  } | null>(null);

  const name = senderLabel(message);

  const domain =
    message.security?.fromDomain ?? addressDomain(message.fromAddress);

  const host = urlHost(methods?.httpsUrl);
  const mailto = mailtoAddress(methods?.mailto);
  const canMail = Boolean(mailto && mailbox.canSend);
  const automatic = Boolean(methods?.oneClick || canMail);

  const linkUrl =
    fallback?.url ?? (automatic ? null : (methods?.httpsUrl ?? null));

  function close(next: boolean) {
    if (!next) setFallback(null);
    onOpenChange(next);
  }

  function recordOpened() {
    unsubscribe.mutate(
      { mailboxId: mailbox.id, messageId: message.id, method: "link" },
      {
        onSuccess: () => close(false),
        onError: (error) => toast.error(error.message),
      }
    );
  }

  function confirm() {
    unsubscribe.mutate(
      { mailboxId: mailbox.id, messageId: message.id, method: "auto" },
      {
        onSuccess: (result) => {
          if (result.outcome === "done") {
            toast.success(`Unsubscribed from ${name}`);
            close(false);
          } else if (result.outcome === "requested") {
            toast.success(
              `Unsubscribe email sent to ${result.unsubscription?.target ?? "the list"}`
            );
            close(false);
          } else if (result.outcome === "link" && result.url) {
            setFallback({ url: result.url, detail: result.detail });
          } else {
            toast.error(result.detail ?? "Could not unsubscribe");
            close(false);
          }
        },
        onError: (error) => toast.error(error.message),
      }
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={close}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <MailMinus className="text-muted-foreground size-4" />
            Unsubscribe from {name}?
          </AlertDialogTitle>
          <AlertDialogDescription
            render={<div />}
            className="space-y-2 text-[13px] leading-5"
          >
            {linkUrl ? (
              <>
                {fallback ? (
                  <p>
                    {fallback.detail ??
                      "We couldn't unsubscribe automatically."}{" "}
                    You can finish on the sender's page.
                  </p>
                ) : (
                  <p>
                    {name} only offers an unsubscribe page. Nothing is opened
                    until you choose to.
                  </p>
                )}
                <p>
                  It opens in a new tab on{" "}
                  <span className="text-foreground font-medium">
                    {urlHost(linkUrl)}
                  </span>
                  , outside OpenWorkspace.
                </p>
              </>
            ) : (
              <>
                <p>
                  {methods?.oneClick ? (
                    <>
                      We'll ask{" "}
                      <span
                        className="text-foreground font-medium"
                        title={host ?? undefined}
                      >
                        {domain}
                      </span>{" "}
                      to stop sending{" "}
                    </>
                  ) : (
                    <>
                      We'll email{" "}
                      <span className="text-foreground font-medium">
                        {mailto}
                      </span>{" "}
                      from {mailbox.address} to stop sending{" "}
                    </>
                  )}
                  {message.listId ? (
                    <>
                      the list{" "}
                      <span className="text-foreground font-medium">
                        {message.listId}
                      </span>
                    </>
                  ) : (
                    "these messages"
                  )}{" "}
                  to {mailbox.address}.
                </p>
                {methods?.oneClick && canMail && (
                  <p title={mailto ?? undefined}>
                    If their server doesn't answer, we'll send an unsubscribe
                    email from {mailbox.address} instead.
                  </p>
                )}
                <p>No links in the message are opened.</p>
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {linkUrl ? (
            <UnsubscribePageLink url={linkUrl} onOpen={recordOpened} />
          ) : (
            <AlertDialogAction
              type="button"
              disabled={unsubscribe.isPending}
              onClick={confirm}
            >
              {unsubscribe.isPending && (
                <LoaderCircle className="animate-spin" />
              )}
              Unsubscribe
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function BlockSenderDialog({
  message,
  mailbox,
  open,
  onOpenChange,
  onMoved,
}: {
  message: MessageDetail;
  mailbox: Mailbox;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMoved?: () => void;
}) {
  const block = useBlockSender();
  const [scope, setScope] = useState<"address" | "domain">("address");
  const [moveExisting, setMoveExisting] = useState(true);
  const name = senderLabel(message);
  const domain = addressDomain(message.fromAddress);
  const ownDomain = domain === addressDomain(mailbox.address);

  function confirm() {
    const pattern = scope === "domain" ? `@${domain}` : message.fromAddress;
    block.mutate(
      { mailboxId: mailbox.id, pattern, moveExisting },
      {
        onSuccess: (result) => {
          toast.success(
            result.moved
              ? `Blocked ${result.block.pattern}; moved ${result.moved} conversation${result.moved === 1 ? "" : "s"} to Spam`
              : `Blocked ${result.block.pattern}`
          );
          onOpenChange(false);

          if (result.moved) onMoved?.();
        },
        onError: (error) => toast.error(error.message),
      }
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldBan className="text-muted-foreground size-4" />
            Block {name}?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-[13px] leading-5">
            New messages will go straight to Spam for everyone using this
            mailbox. The sender isn't told, and you can unblock at any time.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <RadioGroup
          aria-label="What to block"
          value={scope}
          onValueChange={(value: "address" | "domain") => setScope(value)}
        >
          {(
            [
              ["address", message.fromAddress, "Only this address"],
              ["domain", `@${domain}`, "Everyone at this domain"],
            ] as const
          ).map(([value, label, hint]) => (
            <RadioCard
              key={value}
              value={value}
              disabled={value === "domain" && ownDomain}
              className="items-center rounded-md px-3 py-2 data-disabled:opacity-50 *:data-[slot=radio-card-indicator]:mt-0"
            >
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">
                  {label}
                </span>
                <span className="text-muted-foreground block text-xs">
                  {hint}
                </span>
              </span>
            </RadioCard>
          ))}
        </RadioGroup>
        <CheckRow checked={moveExisting} onChange={setMoveExisting}>
          Also move existing conversations to Spam
        </CheckRow>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            type="button"
            variant="destructive"
            disabled={block.isPending}
            onClick={confirm}
          >
            {block.isPending && <LoaderCircle className="animate-spin" />}
            Block
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
