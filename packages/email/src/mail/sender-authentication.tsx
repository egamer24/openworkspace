import { cn } from "@open-workspace/core/ui";
import { ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import type { ReactNode } from "react";

import type {
  AuthResult,
  InboundAuthentication,
  ListUnsubscribe,
  SenderVerdict,
  SenderVerdictReason,
  UpstreamAuthenticationClaim,
} from "../../shared/mail-authentication";

const AUTHENTICATION_DOCS =
  "https://developers.cloudflare.com/email-service/concepts/email-authentication/";

type Tone = "pass" | "fail" | "warn" | "neutral";

function resultTone(
  value: AuthResult | "pass" | "fail" | "none" | null | undefined
): Tone {
  if (value === "pass") return "pass";

  if (value === "fail" || value === "permerror") return "fail";

  if (value === "softfail" || value === "temperror") return "warn";

  return "neutral";
}

function Verdict({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold tracking-wide whitespace-nowrap",
        tone === "pass" && "bg-success/12 text-success",
        tone === "fail" && "bg-destructive/12 text-destructive",
        tone === "warn" && "bg-warning/18 text-amber-800 dark:text-amber-300",
        tone === "neutral" && "bg-muted text-muted-foreground"
      )}
    >
      {children}
    </span>
  );
}

function CheckRow({
  label,
  result,
  href,
  children,
}: {
  label: string;
  result: AuthResult | "pass" | "fail" | "none" | null;
  href: string;
  children?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[3.75rem_4.75rem_minmax(0,1fr)] items-baseline gap-x-3 py-2.5">
      <dt className="text-muted-foreground text-xs font-medium">
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground hover:underline"
        >
          {label}
        </a>
      </dt>
      <dd>
        <Verdict tone={resultTone(result)}>
          {result ? result.toUpperCase() : "N/A"}
        </Verdict>
      </dd>
      <dd className="min-w-0 text-xs leading-5 [overflow-wrap:anywhere] max-sm:col-span-2 max-sm:col-start-2 max-sm:mt-1">
        {children}
      </dd>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[11.5px]">{children}</span>;
}

export const verdictCopy: Record<SenderVerdict, { title: string; tone: Tone }> =
  {
    verified: { title: "Verified sender", tone: "pass" },
    unverified: { title: "Partially verified", tone: "neutral" },
    suspicious: { title: "Unverified sender", tone: "warn" },
    unavailable: { title: "Not checked", tone: "neutral" },
  };

function verdictExplanation(
  reason: SenderVerdictReason,
  fromDomain: string | null
) {
  const domain = fromDomain ?? "the sender's domain";

  switch (reason) {
    case "dmarc_pass": {
      return `DMARC passed: ${domain} authorized this message.`;
    }

    case "aligned_dkim": {
      return `Signed by ${domain}. The domain publishes no DMARC policy.`;
    }

    case "forwarded_arc": {
      return "The message was forwarded. The forwarder recorded passing results before the change.";
    }

    case "dmarc_fail": {
      return `DMARC failed: nothing proves this message came from ${domain}.`;
    }

    case "no_aligned_pass": {
      return `Neither the signature nor the sending server belongs to ${domain}.`;
    }

    case "partial": {
      return `Some checks passed, but ${domain} does not publish a DMARC policy to confirm them.`;
    }

    case "not_cloudflare": {
      return "This message did not arrive through Cloudflare Email Routing, so no receiver checks were recorded.";
    }

    case "missing_results": {
      return "Cloudflare did not report authentication results for this message.";
    }

    default: {
      const unexpected: never = reason;
      throw new Error(`Unknown sender verdict reason: ${String(unexpected)}`);
    }
  }
}

function VerdictSummary({
  authentication,
}: {
  authentication: InboundAuthentication;
}) {
  const copy = verdictCopy[authentication.verdict];

  const Icon =
    copy.tone === "pass"
      ? ShieldCheck
      : copy.tone === "warn"
        ? ShieldAlert
        : ShieldQuestion;

  return (
    <div className="border-border bg-surface-sunken/60 mb-1 flex items-start gap-2.5 rounded-lg border p-3">
      <span
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-full",
          copy.tone === "pass" && "bg-success/12 text-success",
          copy.tone === "warn" &&
            "bg-warning/18 text-amber-700 dark:text-amber-300",
          copy.tone === "neutral" && "bg-muted text-muted-foreground"
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 text-xs leading-5">
        <p className="text-[13px] font-semibold">{copy.title}</p>
        <p className="text-muted-foreground">
          {verdictExplanation(
            authentication.verdictReason,
            authentication.fromDomain
          )}
        </p>
      </div>
    </div>
  );
}

function listFormat(items: string[]) {
  return new Intl.ListFormat("en", {
    style: "long",
    type: "conjunction",
  }).format(items);
}

function claimSummary(claim: UpstreamAuthenticationClaim) {
  return (
    [
      claim.spf && `SPF ${claim.spf}`,
      claim.dkim && `DKIM ${claim.dkim}`,
      claim.dmarc && `DMARC ${claim.dmarc}`,
    ]
      .filter(Boolean)
      .join(", ") || "no results"
  );
}

function SpfRow({ authentication }: { authentication: InboundAuthentication }) {
  const { spf, spfHelo, remoteIp } = authentication;

  return (
    <CheckRow
      label="SPF"
      result={spf?.result ?? null}
      href={`${AUTHENTICATION_DOCS}#spf-sender-policy-framework`}
    >
      {spf ? (
        <>
          {remoteIp && (
            <>
              with IP <Mono>{remoteIp}</Mono>{" "}
            </>
          )}
          {spf.domain && (
            <Muted>
              · mailed-by {spf.domain}
              {spf.aligned ? " (aligned)" : " (not aligned)"}
            </Muted>
          )}
          {spfHelo && (
            <div className="text-muted-foreground text-[11px]">
              HELO {spfHelo.domain ?? authentication.helo ?? "check"}:{" "}
              {spfHelo.result}
            </div>
          )}
        </>
      ) : (
        <Muted>Not reported</Muted>
      )}
    </CheckRow>
  );
}

function DkimRow({
  authentication,
}: {
  authentication: InboundAuthentication;
}) {
  const signatures = [...authentication.dkim].sort(
    (left, right) =>
      Number(right.result === "pass") - Number(left.result === "pass") ||
      Number(right.aligned) - Number(left.aligned)
  );

  const primary = signatures[0];

  return (
    <CheckRow
      label="DKIM"
      result={primary?.result ?? "none"}
      href={`${AUTHENTICATION_DOCS}#dkim-domainkeys-identified-mail`}
    >
      {primary ? (
        <ul className="space-y-0.5">
          {signatures.map((signature, index) => (
            <li key={`${signature.domain}-${index}`}>
              {index === 0
                ? "with domain "
                : signature.result === "pass"
                  ? "Also signed by "
                  : `${signature.result.toUpperCase()}: signed by `}
              <span className="font-medium">{signature.domain}</span>{" "}
              <Muted>
                (
                {[
                  signature.selector && `selector ${signature.selector}`,
                  signature.aligned ? "aligned" : "not aligned",
                ]
                  .filter(Boolean)
                  .join(", ")}
                )
              </Muted>
            </li>
          ))}
        </ul>
      ) : (
        <Muted>The message was not signed</Muted>
      )}
    </CheckRow>
  );
}

function DmarcRow({
  authentication,
}: {
  authentication: InboundAuthentication;
}) {
  const { dmarc } = authentication;
  const href = `${AUTHENTICATION_DOCS}#dmarc-domain-based-message-authentication-reporting--conformance`;

  if (!dmarc) {
    return (
      <CheckRow label="DMARC" result={null} href={href}>
        <Muted>Not reported</Muted>
      </CheckRow>
    );
  }

  const via = dmarc.alignedVia.map((method) => method.toUpperCase());

  return (
    <CheckRow label="DMARC" result={dmarc.result} href={href}>
      {dmarc.result === "none" && !dmarc.policy ? (
        <Muted>
          {dmarc.headerFrom ?? "The domain"} publishes no DMARC policy
        </Muted>
      ) : (
        <>
          {dmarc.policy && (
            <>
              policy <span className="font-medium">{dmarc.policy}</span>
            </>
          )}
          {via.length > 0 && <Muted> · aligned via {listFormat(via)}</Muted>}
          {dmarc.policy === "none" && (
            <div className="text-muted-foreground text-[11px]">
              Monitoring only: the domain does not ask receivers to reject
              failures.
            </div>
          )}
        </>
      )}
    </CheckRow>
  );
}

function ArcRow({ authentication }: { authentication: InboundAuthentication }) {
  const { arc } = authentication;
  const href = "https://www.rfc-editor.org/rfc/rfc8617.html";

  if (!arc || (arc.result === "none" && arc.chainLength <= 1)) {
    return (
      <CheckRow label="ARC" result="none" href={href}>
        <Muted>No forwarding chain</Muted>
      </CheckRow>
    );
  }

  const sealers = arc.sealers.flatMap((sealer) =>
    sealer.domain ? [sealer.domain] : []
  );

  return (
    <CheckRow label="ARC" result={arc.result} href={href}>
      {sealers.length > 0 && (
        <>
          Forwarded via{" "}
          <span className="font-medium">{listFormat(sealers)}</span>
        </>
      )}
      {arc.result === "fail" && (
        <div className="text-destructive">
          The forwarding chain is broken; earlier results cannot be trusted.
        </div>
      )}
      {arc.oldest && (
        <div className="text-muted-foreground text-[11px]">
          Before forwarding: {claimSummary(arc.oldest)} · reported by{" "}
          {arc.oldest.authservId}, chain verified by Cloudflare
        </div>
      )}
    </CheckRow>
  );
}

function SpamScore({ score }: { score: number | null }) {
  if (score === null) return null;

  return (
    <div className="grid grid-cols-[3.75rem_4.75rem_minmax(0,1fr)] items-baseline gap-x-3 py-2.5">
      <dt className="text-muted-foreground text-xs font-medium">Spam</dt>
      <dd>
        <Verdict tone={score >= 3 ? "warn" : "neutral"}>{score} / 5</Verdict>
      </dd>
      <dd className="text-muted-foreground text-xs leading-5 max-sm:col-span-2 max-sm:col-start-2 max-sm:mt-1">
        Cloudflare spam score (X-CF-SpamH-Score). Experimental; not used to
        filter mail.
      </dd>
    </div>
  );
}

/** Gmail-style SPF / DKIM / DMARC / ARC lines from the trusted Cloudflare results. */
export function SenderAuthentication({
  authentication,
}: {
  authentication: InboundAuthentication | null;
}) {
  if (!authentication) {
    return (
      <p className="text-muted-foreground text-xs">
        Authentication results are not available for this message.
      </p>
    );
  }

  const unavailable = authentication.verdict === "unavailable";

  return (
    <div>
      <VerdictSummary authentication={authentication} />
      {!unavailable && (
        <dl className="divide-border divide-y">
          <SpfRow authentication={authentication} />
          <DkimRow authentication={authentication} />
          <DmarcRow authentication={authentication} />
          <ArcRow authentication={authentication} />
          <SpamScore score={authentication.spamScore} />
        </dl>
      )}
      {unavailable && authentication.spamScore !== null && (
        <dl>
          <SpamScore score={authentication.spamScore} />
        </dl>
      )}
      {(authentication.ignoredCloudflareClaims > 0 ||
        authentication.upstream.length > 0) && (
        <div className="border-border text-muted-foreground mt-2 space-y-1 border-t pt-2.5 text-[11px] leading-4">
          {authentication.ignoredCloudflareClaims > 0 && (
            <p className="text-amber-800 dark:text-amber-300">
              Ignored {authentication.ignoredCloudflareClaims} header
              {authentication.ignoredCloudflareClaims === 1 ? "" : "s"} below
              Cloudflare's block that claimed to come from Cloudflare.
            </p>
          )}
          {authentication.upstream.map((claim, index) => (
            <p key={index}>
              Reported by {claim.authservId} (unverified, added before
              Cloudflare): {claimSummary(claim)}
            </p>
          ))}
        </div>
      )}
      {authentication.trustedHeader && (
        <details className="group mt-2 text-[11px]">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer select-none">
            Trusted Authentication-Results header
          </summary>
          <pre className="bg-surface-sunken ring-border mt-1.5 overflow-x-auto rounded-md p-2.5 font-mono text-[10.5px] leading-[1.55] [overflow-wrap:anywhere] whitespace-pre-wrap ring-1">
            {authentication.trustedHeader.replaceAll(/;\s*/gu, ";\n    ")}
          </pre>
        </details>
      )}
    </div>
  );
}

const unsubscribeReasons: Record<
  NonNullable<ListUnsubscribe["reason"]>,
  string
> = {
  "invalid-uri": "the header has no valid link or address",
  "no-https": "only an email address is offered",
  "no-post": "the sender did not opt in to one-click (RFC 8058)",
  unsigned: "no passing DKIM signature covers the header",
  unaligned: "the covering signature does not belong to the sender's domain",
  "post-not-signed": "the signature does not cover List-Unsubscribe-Post",
};

export function unsubscribeSummary(value: ListUnsubscribe) {
  const methods: string[] = [];

  if (value.httpsUrl) methods.push("link");

  if (value.mailto) methods.push("email");

  if (value.oneClick) {
    return `One-click (RFC 8058)${value.mailto ? ", email" : ""}`;
  }

  const listed = listFormat(methods);

  const offered = methods.length
    ? `${listed.charAt(0).toUpperCase()}${listed.slice(1)}`
    : "Not usable";

  return value.reason
    ? `${offered} · no one-click: ${unsubscribeReasons[value.reason]}`
    : offered;
}
