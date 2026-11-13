import {
  Button,
  buttonVariants,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  responseJson,
  cn,
} from "@open-workspace/core/ui";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  BadgeCheck,
  Check,
  Copy,
  Download,
  LoaderCircle,
  Lock,
  LockOpen,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";

import { mailApi } from "../lib/mail-api";
import { formatBytes } from "./format-bytes";
import {
  ipKind,
  mimeStructure,
  originalSenderDetails,
  receivedHops,
  transitTime,
} from "./original-message";
import type { IpKind, MimePart, ReceivedHop } from "./original-message";
import {
  SenderAuthentication,
  unsubscribeSummary,
} from "./sender-authentication";
import { senderIntelRows } from "./sender-security";
import type { MessageDetail } from "./types";

export function originalSourceUrl(mailboxId: string, messageId: string) {
  return `/api/mail/messages/${encodeURIComponent(messageId)}/original?mailboxId=${encodeURIComponent(mailboxId)}`;
}

const errorBody = z.object({ error: z.object({ message: z.string() }) });

async function responseMessage(response: Response) {
  try {
    const body = errorBody.safeParse(await response.json());

    return body.success ? body.data.error.message : undefined;
  } catch {
    return undefined;
  }
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-border border-t px-5 py-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function AiCheck({
  classification,
}: {
  classification: NonNullable<MessageDetail["aiClassification"]>;
}) {
  const score = Math.round(classification.spamConfidence * 100);

  return (
    <div className="border-border bg-surface-sunken/60 rounded-lg border p-3.5">
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-full",
            classification.spam
              ? "bg-destructive/12 text-destructive"
              : "bg-success/12 text-success"
          )}
        >
          {classification.spam ? (
            <ShieldAlert className="size-4" />
          ) : (
            <ShieldCheck className="size-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold">
            {classification.spam ? "Looks like spam" : "Looks legitimate"}
          </p>
          <p className="text-muted-foreground text-xs">
            Spam likelihood {score}%
          </p>
        </div>
      </div>
      <div
        className="bg-muted mt-3 h-1.5 overflow-hidden rounded-full"
        aria-hidden="true"
      >
        <div
          className={cn(
            "h-full rounded-full",
            classification.spam ? "bg-destructive" : "bg-success"
          )}
          style={{ width: `${Math.max(score, 2)}%` }}
        />
      </div>
      <p className="mt-3 text-[13px] leading-5">{classification.reason}</p>
      <p className="text-muted-foreground mt-2 font-mono text-[11px]">
        {classification.model} ·{" "}
        {format(new Date(classification.processedAt), "MMM d, HH:mm")}
      </p>
    </div>
  );
}

const MAX_DISPLAY_DELAY_MS = 7 * 24 * 3_600_000;

function formatDelay(ms: number) {
  if (ms > MAX_DISPLAY_DELAY_MS) return "> 7 d";

  if (ms < 1000) return `${ms} ms`;

  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;

  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;

  return `${(ms / 3_600_000).toFixed(1)} h`;
}

const ipKindLabels: Record<IpKind, string> = {
  public: "Public",
  private: "Private network",
  loopback: "Loopback",
  reserved: "Reserved range",
};

function IpAddress({ ip }: { ip: string }) {
  const kind = ipKind(ip);

  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="font-mono text-[11.5px] whitespace-nowrap">{ip}</span>
      <span
        className={cn(
          "rounded px-1 py-px text-[10px] font-medium whitespace-nowrap",
          kind === "public"
            ? "bg-info/10 text-info"
            : "bg-muted text-muted-foreground"
        )}
      >
        {ipKindLabels[kind]}
      </span>
    </span>
  );
}

function HopDelay({ hop }: { hop: ReceivedHop }) {
  if (hop.delayMs === null) return null;

  return (
    <span
      className="text-muted-foreground shrink-0 text-[11px] tabular-nums"
      title={
        hop.skewMs === null
          ? undefined
          : "This server's clock is behind the previous one"
      }
    >
      +{formatDelay(hop.delayMs)}
      {hop.skewMs !== null && <> (clock skew −{formatDelay(-hop.skewMs)})</>}
    </span>
  );
}

function DeliveryPath({
  hops,
  transit,
  deliveredAt,
}: {
  hops: ReceivedHop[];
  transit: ReturnType<typeof transitTime>;
  deliveredAt: Date;
}) {
  if (!hops.length) {
    return (
      <p className="text-muted-foreground text-xs">
        No Received headers in this message.
      </p>
    );
  }

  const arrival = hops.find((hop) => hop.trusted)?.at;

  const mailboxDelay = arrival
    ? deliveredAt.getTime() - arrival.getTime()
    : null;

  return (
    <>
      <ol className="relative">
        {hops.map((hop, index) => (
          <li
            key={index}
            className="relative grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2.5 pb-3.5 last:pb-0"
          >
            <span aria-hidden="true" className="relative flex justify-center">
              <span
                className={cn(
                  "bg-surface z-10 mt-1 size-2.5 rounded-full border-2",
                  hop.trusted ? "border-success" : "border-muted-foreground/50"
                )}
              />
              {index < hops.length - 1 && (
                <span className="bg-border absolute top-3.5 bottom-[-0.25rem] w-px" />
              )}
            </span>
            <div className="min-w-0 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <p
                  className="min-w-0 truncate font-medium"
                  title={hop.by ?? undefined}
                >
                  {hop.by ?? "Unknown server"}
                </p>
                <HopDelay hop={hop} />
              </div>
              <p className="text-muted-foreground mt-0.5 [overflow-wrap:anywhere]">
                from {hop.from ?? "unknown"}
                {hop.reverseDns && <> · rDNS {hop.reverseDns}</>}
              </p>
              <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                {hop.trusted ? (
                  <span className="text-success inline-flex items-center gap-1 font-medium">
                    <BadgeCheck className="size-3" />
                    Verified by Cloudflare
                  </span>
                ) : (
                  <span className="text-[11px]">Reported by sender</span>
                )}
                {hop.ip && <IpAddress ip={hop.ip} />}
                {hop.protocol && (
                  <span className="font-mono text-[11px]">{hop.protocol}</span>
                )}
                {hop.tls ? (
                  <span className="text-success inline-flex items-center gap-1">
                    <Lock className="size-3" />
                    {hop.tls}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <LockOpen className="size-3" />
                    {hop.trusted ? "TLS not reported" : "No TLS noted"}
                  </span>
                )}
                {hop.at && (
                  <span className="tabular-nums">
                    {format(hop.at, "HH:mm:ss")}
                  </span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
      <p className="text-muted-foreground mt-3 text-[11px]">
        {[
          `${hops.length} hop${hops.length === 1 ? "" : "s"}`,
          transit &&
            `in transit ${formatDelay(transit.ms)}${transit.basis === "date-header" ? " since the sender's Date header" : ""}`,
          mailboxDelay !== null &&
            mailboxDelay >= 0 &&
            `delivered to the mailbox +${formatDelay(mailboxDelay)}`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </>
  );
}

function MimeTree({ parts }: { parts: MimePart[] }) {
  return (
    <ul className="space-y-1 text-xs">
      {parts.map((part, index) => (
        <li
          key={index}
          className="flex items-baseline gap-2"
          style={{ paddingLeft: `${part.depth * 0.875}rem` }}
        >
          <span className="font-mono text-[11.5px]">{part.contentType}</span>
          <span className="text-muted-foreground min-w-0 truncate">
            {[
              part.filename,
              part.charset,
              part.encoding,
              part.contentType.startsWith("multipart/")
                ? null
                : formatBytes(part.bytes),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </li>
      ))}
    </ul>
  );
}

function DetailRows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="[overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function OriginalMessageBody({
  mailboxId,
  message,
}: {
  mailboxId: string;
  message: MessageDetail;
}) {
  const [copied, setCopied] = useState(false);
  const sourceUrl = originalSourceUrl(mailboxId, message.id);

  const source = useQuery({
    queryKey: ["message-original", mailboxId, message.id],
    queryFn: async () => {
      const response = await fetch(sourceUrl);

      if (!response.ok) {
        throw new Error(
          (await responseMessage(response)) ??
            `Original message failed (${response.status})`
        );
      }

      return response.text();
    },
    staleTime: Infinity,
  });

  const details = useQuery({
    queryKey: ["message-authentication", mailboxId, message.id],
    queryFn: async () =>
      responseJson(
        await mailApi.api.mail.messages[":messageId"].authentication.$get({
          param: { messageId: message.id },
          query: { mailboxId },
        })
      ),
    staleTime: Infinity,
  });

  const authentication = details.data?.authentication ?? null;
  const security = details.data?.security ?? null;
  const original = details.data?.original;
  const senderIntel = details.data?.senderIntel ?? message.senderIntel;

  const parsed = useMemo(() => {
    if (!source.data) return null;
    const hops = receivedHops(source.data);

    return {
      hops,
      transit: transitTime(source.data, hops),
      sender: originalSenderDetails(source.data, authentication, hops),
      parts: mimeStructure(source.data),
    };
  }, [source.data, authentication]);

  const sourceBytes = useMemo(
    () =>
      source.data ? new TextEncoder().encode(source.data).byteLength : null,
    [source.data]
  );

  function senderRows(sender: NonNullable<typeof parsed>["sender"]) {
    const rows: [string, ReactNode][] = [
      ["Return-Path", sender.returnPath ?? "—"],
    ];

    if (
      original?.envelopeTo &&
      !message.toAddresses.includes(original.envelopeTo)
    ) {
      rows.push(["Envelope to", original.envelopeTo]);
    }

    rows.push([
      "Sending IP",
      sender.senderIp ? (
        // oxlint-disable-next-line react/jsx-key -- a [label, value] row, rendered with the label as key
        <IpAddress ip={sender.senderIp} />
      ) : (
        "—"
      ),
    ]);

    if (authentication?.helo) rows.push(["HELO", authentication.helo]);

    if (senderIntel?.ip) rows.push(...senderIntelRows(senderIntel));

    if (security?.mailedBy) rows.push(["Mailed-by", security.mailedBy]);

    if (security?.signedBy) rows.push(["Signed-by", security.signedBy]);

    if (message.replyToAddresses.length) {
      rows.push(["Reply-To", message.replyToAddresses.join(", ")]);
    }

    if (sender.mailer) rows.push(["Mailer", sender.mailer]);

    if (sender.listId) rows.push(["List", sender.listId]);

    if (security?.listUnsubscribe) {
      rows.push(["Unsubscribe", unsubscribeSummary(security.listUnsubscribe)]);
    }

    if (sender.precedence) rows.push(["Precedence", sender.precedence]);

    return rows;
  }

  async function copySource() {
    if (!source.data) return;
    await navigator.clipboard.writeText(source.data);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {original && (
        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-5 pb-4 text-xs">
          <dt className="text-muted-foreground">From</dt>
          <dd className="[overflow-wrap:anywhere]">{original.from}</dd>
          <dt className="text-muted-foreground">To</dt>
          <dd className="[overflow-wrap:anywhere]">{original.to.join(", ")}</dd>
          <dt className="text-muted-foreground">Received</dt>
          <dd>
            {format(
              new Date(original.receivedAt),
              "EEE, MMM d, yyyy 'at' HH:mm:ss"
            )}
          </dd>
          <dt className="text-muted-foreground">Message-ID</dt>
          <dd className="font-mono text-[11px] [overflow-wrap:anywhere]">
            {original.messageId ?? "Unavailable"}
          </dd>
        </dl>
      )}

      <div className="border-border lg:divide-border grid border-t lg:grid-cols-2 lg:divide-x [&>div>section:first-child]:border-t-0">
        <div className="min-w-0">
          <Section
            title="AI check"
            aside={<Sparkles className="text-muted-foreground size-3.5" />}
          >
            {message.aiClassification ? (
              <AiCheck classification={message.aiClassification} />
            ) : (
              <p className="text-muted-foreground text-xs">
                This message was not checked by AI sorting.
              </p>
            )}
          </Section>

          <Section
            title="Authentication"
            aside={
              authentication?.authservId ? (
                <span className="text-muted-foreground font-mono text-[11px]">
                  {authentication.authservId}
                </span>
              ) : undefined
            }
          >
            {details.isLoading ? (
              <p className="text-muted-foreground flex items-center gap-2 py-2 text-xs">
                <LoaderCircle className="size-3.5 animate-spin" /> Reading
                authentication results…
              </p>
            ) : details.isError ? (
              <p className="text-destructive text-xs">
                {details.error.message}
              </p>
            ) : (
              <SenderAuthentication authentication={authentication} />
            )}
          </Section>

          {parsed && (
            <Section title="Sender">
              <DetailRows rows={parsed ? senderRows(parsed.sender) : []} />
            </Section>
          )}
        </div>
        <div className="min-w-0">
          <Section title="Delivery path">
            {parsed ? (
              <DeliveryPath
                hops={parsed.hops}
                transit={parsed.transit}
                deliveredAt={new Date(message.timelineAt)}
              />
            ) : (
              <p className="text-muted-foreground text-xs">Loading…</p>
            )}
          </Section>
          {parsed && parsed.parts.length > 0 && (
            <Section title="Structure">
              <MimeTree parts={parsed.parts} />
            </Section>
          )}
        </div>
      </div>

      <Section
        title="Raw source"
        aside={
          <div className="flex items-center gap-1">
            {sourceBytes !== null && (
              <span className="text-muted-foreground mr-1 text-[11px] tabular-nums">
                {sourceBytes.toLocaleString()} bytes
              </span>
            )}
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void copySource()}
              disabled={!source.data}
            >
              {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
            </Button>
            <a
              className={buttonVariants({ variant: "ghost", size: "xs" })}
              href={sourceUrl}
              download={`${message.id}.eml`}
            >
              <Download /> Download
            </a>
          </div>
        }
      >
        {source.isLoading ? (
          <div className="bg-surface-sunken text-muted-foreground grid h-40 place-items-center rounded-md">
            <LoaderCircle className="size-4 animate-spin" />
          </div>
        ) : source.isError ? (
          <p className="text-destructive text-xs">{source.error.message}</p>
        ) : (
          <pre className="bg-surface-sunken ring-border max-h-[50dvh] overflow-auto rounded-md p-3 font-mono text-[11px] leading-[1.6] whitespace-pre ring-1">
            {source.data}
          </pre>
        )}
      </Section>
    </div>
  );
}

/** Original source, authentication results and the AI check, beside the conversation. */
export function OriginalMessageSheet({
  mailboxId,
  message,
  onClose,
}: {
  mailboxId: string;
  message: MessageDetail | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={Boolean(message)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full gap-0 data-[side=right]:sm:max-w-[min(72rem,94vw)]"
      >
        {message && (
          <>
            <SheetHeader className="px-5 pt-5 pb-3">
              <SheetTitle>Original message</SheetTitle>
              <SheetDescription className="truncate pr-8">
                {message.subject || "(no subject)"}
              </SheetDescription>
            </SheetHeader>
            <OriginalMessageBody mailboxId={mailboxId} message={message} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
