/* oxlint-disable react/jsx-key -- rows are [label, value] tuples, rendered with the label as key */
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@open-workspace/core/ui";
import {
  Ban,
  Check,
  LoaderCircle,
  OctagonAlert,
  ShieldQuestion,
  X,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { countryFlag } from "../../shared/mail-sender-intel";
import type {
  LookupStatus,
  SecurityWarning,
  SenderIntel,
  SpamhausCheck,
} from "../../shared/mail-sender-intel";
import { Monogram } from "./mail-primitives";
import type { MessageDetail } from "./types";

/** BIMI logo when DMARC allowed one, else the initials monogram. */
export function SenderAvatar({
  name,
  logoUrl,
  className,
}: {
  name: string;
  logoUrl?: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);

  if (logoUrl && failed !== logoUrl) {
    return (
      <img
        src={logoUrl}
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={() => setFailed(logoUrl)}
        className={cn(
          "bg-surface ring-border shrink-0 object-cover ring-1",
          className
        )}
      />
    );
  }

  return <Monogram name={name} className={className} />;
}

const lookupFailure: Partial<Record<LookupStatus, string>> = {
  timeout: "Lookup timed out",
  error: "Lookup failed",
  skipped: "Not checked",
};

function networkLabel(network: SenderIntel["network"]) {
  if (network.asn === null) return null;

  return [`AS${network.asn}`, network.asName].filter(Boolean).join(" ");
}

function Country({ code }: { code: string | null }) {
  if (!code) return null;
  const flag = countryFlag(code);

  return (
    <span className="whitespace-nowrap" title={code}>
      {flag && (
        <span aria-hidden="true" className="mr-0.5">
          {flag}
        </span>
      )}
      {code}
    </span>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function spamhausRow(
  label: string,
  check: SpamhausCheck,
  target: ReactNode
): [string, ReactNode] {
  if (check.status !== "ok") {
    return [
      label,
      <Muted>
        {check.error ?? lookupFailure[check.status] ?? "Not checked"}
      </Muted>,
    ];
  }

  if (!check.listings.length) {
    return [
      label,
      <span className="inline-flex items-center gap-1">
        <Check className="text-success size-3" />
        Not listed <Muted>{target}</Muted>
      </span>,
    ];
  }

  return [
    label,
    <ul className="space-y-0.5">
      {check.listings.map((listing) => (
        <li
          key={`${listing.target}-${listing.code}`}
          className={
            listing.severity === "abuse"
              ? "text-destructive"
              : "text-amber-800 dark:text-amber-300"
          }
        >
          <span className="font-medium">{listing.target}</span> · {listing.list}{" "}
          <span className="font-mono text-[10.5px] opacity-75">
            {listing.code}
          </span>
        </li>
      ))}
    </ul>,
  ];
}

/** Rows for the "Sender" section of Show original. */
export function senderIntelRows(intel: SenderIntel): [string, ReactNode][] {
  const rows: [string, ReactNode][] = [];
  const ptrFailure = lookupFailure[intel.ptr.status];
  rows.push([
    "Reverse DNS",
    intel.ptr.names.length ? (
      <span>
        {intel.ptr.names.join(", ")}
        {intel.ptr.generic && (
          <Muted> · looks like a dynamic or end-user address</Muted>
        )}
      </span>
    ) : (
      <Muted>{ptrFailure ?? "No PTR record"}</Muted>
    ),
  ]);

  if (intel.ptr.status === "ok" || intel.ptr.status === "nxdomain") {
    rows.push([
      "FCrDNS",
      intel.ptr.fcrdns ? (
        <span>
          <span className="text-success">
            <Check className="mr-1 inline size-3 align-[-1px]" />
            Forward-confirmed
          </span>
          <Muted> · the name resolves back to {intel.ip}</Muted>
        </span>
      ) : (
        <span className="text-amber-800 dark:text-amber-300">
          <X className="mr-1 inline size-3 align-[-1px]" />
          {intel.ptr.names.length
            ? "The name does not resolve back to this IP"
            : "No reverse DNS to confirm"}
        </span>
      ),
    ]);
  }

  if (intel.heloMatchesPtr !== null) {
    rows.push([
      "HELO match",
      intel.heloMatchesPtr ? (
        "HELO matches the reverse DNS"
      ) : (
        <Muted>HELO differs from the reverse DNS</Muted>
      ),
    ]);
  }

  const network = networkLabel(intel.network);
  rows.push([
    "Network",
    network ? (
      <span className="inline-flex flex-wrap items-center gap-x-1.5">
        <span className="font-medium">{network}</span>
        {intel.network.prefix && <Muted>· {intel.network.prefix}</Muted>}
        {intel.network.country && (
          <Muted>
            · <Country code={intel.network.country} />
          </Muted>
        )}
        {intel.network.registry && (
          <Muted>· {intel.network.registry.toUpperCase()}</Muted>
        )}
      </span>
    ) : (
      <Muted>{lookupFailure[intel.network.status] ?? "No ASN data"}</Muted>
    ),
  ]);

  if (intel.spamhaus) {
    rows.push(
      spamhausRow(
        "Spamhaus ZEN",
        intel.spamhaus.zen,
        intel.ip ? `(${intel.ip})` : null
      ),
      spamhausRow(
        "Spamhaus DBL",
        intel.spamhaus.dbl,
        intel.spamhaus.dbl.domains.length
          ? `(${intel.spamhaus.dbl.domains.length} domain${intel.spamhaus.dbl.domains.length === 1 ? "" : "s"})`
          : null
      )
    );
  }

  if (intel.bimi) {
    rows.push([
      "BIMI",
      intel.bimi.status === "ok" ? (
        <span>
          Logo from {intel.bimi.domain}{" "}
          <Muted>· not verified with a mark certificate</Muted>
        </span>
      ) : (
        <Muted>{intel.bimi.reason ?? "No logo"}</Muted>
      ),
    ]);
  }

  rows.push([
    "Checked",
    <Muted>
      {new Date(intel.checkedAt).toLocaleString("en", {
        dateStyle: "medium",
        timeStyle: "short",
      })}
      {intel.source === "demo"
        ? " · demo data"
        : " · DNS over HTTPS, Team Cymru"}
    </Muted>,
  ]);

  return rows;
}

function listFormat(items: string[]) {
  return new Intl.ListFormat("en", {
    style: "long",
    type: "conjunction",
  }).format(items);
}

function warningHeadline(warning: SecurityWarning, message: MessageDetail) {
  switch (warning.kind) {
    case "dbl_listed": {
      const lists = listFormat(
        warning.lists.map((list) => list.replace(/^DBL /u, "a "))
      );

      return warning.senderDomain
        ? `The sender's domain ${warning.domains[0]} is on the Spamhaus Domain Blocklist as ${lists}.`
        : `Links in this message lead to ${listFormat(warning.domains)}, which Spamhaus lists as ${lists}.`;
    }

    case "lookalike_domain": {
      return `${warning.domain} looks like ${warning.resembles}, but it is a different domain.`;
    }

    case "display_name_impersonation": {
      return `This sender uses the name ${warning.name}, but ${message.fromAddress} is outside your organization.`;
    }

    case "zen_listed": {
      return warning.severity === "danger"
        ? `The sending server ${warning.ip} is on a Spamhaus blocklist (${listFormat(warning.lists)}).`
        : `The sending server ${warning.ip} is in an end-user address range (${listFormat(warning.lists)}).`;
    }

    case "embedded_address": {
      return `The sender's name shows ${warning.claimed}, but the message came from ${message.fromAddress}.`;
    }

    case "unverified_sender": {
      return `We couldn't verify that this message came from ${warning.domain ?? message.fromAddress}.`;
    }

    case "reply_to_mismatch": {
      return `Replies go to ${warning.address}, not to ${message.security?.fromDomain ?? "the sender's domain"}.`;
    }

    case "addressed_elsewhere": {
      const via = warning.forwardedVia
        ? ` through ${warning.forwardedVia}`
        : "";

      return warning.severity === "danger"
        ? `This account alert is about ${warning.addressedTo}, not you, and was forwarded to you${via}. Real alerts only go to the account they are about.`
        : `This message was written for ${warning.addressedTo} and forwarded to you${via}.`;
    }

    default: {
      const unexpected: never = warning;
      throw new Error(
        `Unknown security warning: ${JSON.stringify(unexpected)}`
      );
    }
  }
}

/**
 * One calm banner for every sender warning on a message: the most serious
 * one is the headline, the rest follow as short lines.
 */
export function SenderSecurityBanner({
  message,
  onShowOriginal,
  onTrust,
}: {
  message: MessageDetail;
  onShowOriginal?: () => void;
  /** Offered only when every warning is caution-level. */
  onTrust?: () => void;
}) {
  const warnings = message.security?.warnings ?? [];
  const [first, ...rest] = warnings;
  const pending = message.senderIntelPending;

  if (!first) {
    // Blocklist results can still add a warning: say so instead of nothing.
    return pending ? (
      <p
        role="status"
        data-testid="sender-intel-pending"
        className="text-muted-foreground mt-3 flex items-center gap-2 text-xs @lg/reader:ml-12"
      >
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
        Checking the sender's server and blocklists…
      </p>
    ) : null;
  }

  const danger = warnings.some((warning) => warning.severity === "danger");
  const Icon = danger ? OctagonAlert : ShieldQuestion;

  return (
    <div
      role="note"
      data-testid="sender-security-banner"
      className={cn(
        "text-foreground mt-3 flex items-start gap-2.5 rounded-md px-3 py-2 text-xs ring-1 ring-inset @lg/reader:ml-12",
        danger
          ? "bg-destructive/6 ring-destructive/20"
          : "bg-warning/10 ring-warning/25"
      )}
    >
      <Icon
        className={cn(
          "mt-px size-3.5 shrink-0",
          danger ? "text-destructive" : "text-amber-700 dark:text-amber-300"
        )}
      />
      <div className="min-w-0 flex-1 leading-5">
        <p className="font-medium">{warningHeadline(first, message)}</p>
        {rest.length > 0 && (
          <ul className="text-muted-foreground marker:text-border mt-0.5 list-disc pl-4">
            {rest.map((warning) => (
              <li key={warning.kind}>{warningHeadline(warning, message)}</li>
            ))}
          </ul>
        )}
        <p className="text-muted-foreground">
          {pending && "Still checking the sender's server and blocklists. "}
          {message.security?.firstTimeSender &&
            "This is the first message from this address. "}
          Be careful with links, attachments, and requests for payment or
          sign-in details.
          {onTrust && !danger && !pending && !message.sender?.block && (
            <>
              {" "}
              <Tooltip>
                <TooltipTrigger
                  render={
                    // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the tooltip trigger renders its children inside this button
                    <button
                      type="button"
                      onClick={onTrust}
                      className={cn(
                        bannerLinkClass,
                        "decoration-border underline"
                      )}
                    />
                  }
                >
                  I know this sender
                </TooltipTrigger>
                <TooltipContent>
                  Trust this sender: hide these hints for future messages
                </TooltipContent>
              </Tooltip>
            </>
          )}
        </p>
      </div>
      {onShowOriginal && (
        <button
          type="button"
          onClick={onShowOriginal}
          className={bannerLinkClass}
        >
          Details
        </button>
      )}
    </div>
  );
}

const bannerLinkClass =
  "shrink-0 rounded-sm font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring";

function shortDay(at: number) {
  return new Date(at).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    year:
      new Date(at).getFullYear() === new Date().getFullYear()
        ? undefined
        : "numeric",
  });
}

const unsubscribedCopy = {
  done: "Unsubscribed",
  requested: "Unsubscribe requested",
  opened: "Unsubscribe page opened",
  failed: null,
} as const;

/** "Unsubscribe" beside the sender, or what happened when someone already did. */
export function SubscriptionAction({
  message,
  onUnsubscribe,
}: {
  message: MessageDetail;
  onUnsubscribe?: () => void;
}) {
  const record = message.unsubscription;
  const label = record ? unsubscribedCopy[record.status] : null;

  if (label && record) {
    return (
      <span
        data-testid="unsubscribed-label"
        className="text-muted-foreground hidden shrink-0 text-xs @sm/reader:inline"
        title={`${label} on ${new Date(record.at).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })}${record.target ? ` via ${record.target}` : ""}`}
      >
        {label} on {shortDay(record.at)}
      </span>
    );
  }

  if (!onUnsubscribe) return null;

  return (
    <button
      type="button"
      onClick={onUnsubscribe}
      className="text-muted-foreground decoration-border hover:text-foreground focus-visible:ring-ring hidden shrink-0 rounded-sm px-0.5 text-xs font-medium underline underline-offset-2 outline-none hover:decoration-current focus-visible:ring-2 @sm/reader:inline"
    >
      Unsubscribe
    </button>
  );
}

/** Calm one-liners for decisions people made about this sender or message. */
export function SenderStatusNotice({
  message,
  onUnblock,
}: {
  message: MessageDetail;
  onUnblock?: () => void;
}) {
  const block = message.sender?.block;

  const lines: {
    key: string;
    text: string;
    action?: { label: string; run: () => void };
  }[] = [];

  if (block) {
    lines.push({
      key: "block",
      text: block.workspace
        ? `An administrator blocked ${block.pattern} for everyone. New messages go to Spam.`
        : `You blocked ${block.scope === "domain" ? `everyone at ${block.pattern.slice(1)}` : block.pattern}. New messages go to Spam.`,
      action:
        !block.workspace && onUnblock
          ? { label: "Unblock", run: onUnblock }
          : undefined,
    });
  }

  if (message.reported) {
    lines.push({ key: "report", text: "Reported as spam." });
  }

  if (!lines.length) return null;

  return (
    <div
      data-testid="sender-status-notice"
      className="mt-3 space-y-1 @lg/reader:ml-12"
    >
      {lines.map((line) => (
        <p
          key={line.key}
          className="text-muted-foreground flex items-center gap-2 text-xs"
        >
          <Ban className="size-3.5 shrink-0" />
          <span className="min-w-0">{line.text}</span>
          {line.action && (
            <button
              type="button"
              onClick={line.action.run}
              className={bannerLinkClass}
            >
              {line.action.label}
            </button>
          )}
        </p>
      ))}
    </div>
  );
}
