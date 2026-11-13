import type {
  InboundAuthentication,
  ListUnsubscribe,
  MessageSecurity,
} from "../../shared/mail-authentication";
import { addressDomain } from "../../shared/mail-headers";
import type {
  DeliveryFacts,
  SecurityWarning,
  SenderIntel,
} from "../../shared/mail-sender-intel";
import { addressedElsewhereWarning } from "./delivery-facts";
import {
  embeddedAddress,
  impersonatedName,
  lookalikeOf,
} from "./impersonation";
import { organizationalDomain, relaxedAligned } from "./org-domain";

export function isWorkspaceDomain(
  domain: string | null,
  workspaceDomains: readonly string[]
) {
  if (!domain) return false;

  return workspaceDomains.some((candidate) => {
    const name = candidate.toLocaleLowerCase();

    return domain === name || domain.endsWith(`.${name}`);
  });
}

/** Mailbox-local history for the From address (`senders` table). */
export type SenderHistory = {
  inboundCount: number;
  outboundCount: number;
};

const warningOrder: Record<SecurityWarning["kind"], number> = {
  dbl_listed: 0,
  lookalike_domain: 1,
  display_name_impersonation: 2,
  addressed_elsewhere: 3,
  zen_listed: 4,
  unverified_sender: 5,
  embedded_address: 6,
  reply_to_mismatch: 7,
};

/**
 * The first Reply-To address whose organizational domain differs from the
 * From organizational domain. Mailing lists legitimately redirect replies.
 */
export function replyToMismatch(input: {
  fromAddress: string;
  replyTo: readonly string[];
  listId: string | null;
}) {
  if (input.listId) return null;
  const fromOrg = organizationalDomain(input.fromAddress);

  if (!fromOrg) return null;

  for (const address of input.replyTo) {
    const domain = organizationalDomain(address);

    if (domain && domain !== fromOrg) {
      return { address: address.toLocaleLowerCase(), domain };
    }
  }

  return null;
}

/**
 * Prioritized warnings for one message, most serious first. The reader shows
 * the first as the banner headline and folds the rest into it.
 */
export function securityWarnings(input: {
  fromAddress: string;
  fromName: string | null;
  external: boolean;
  fromDomain: string | null;
  authentication: InboundAuthentication | null;
  intel: SenderIntel | null;
  workspaceDomains: readonly string[];
  internalNames: ReadonlyMap<string, string>;
  history: SenderHistory | null;
  replyTo?: readonly string[];
  listId?: string | null;
  delivery?: DeliveryFacts | null;
  /** Trusted senders keep only danger-level warnings. */
  trusted?: boolean;
}): SecurityWarning[] {
  const warnings: SecurityWarning[] = [];
  const spamhaus = input.intel?.spamhaus;
  const dbl = spamhaus?.dbl.listings ?? [];

  if (dbl.length) {
    const fromOrg = organizationalDomain(input.fromDomain);
    warnings.push({
      kind: "dbl_listed",
      severity: "danger",
      domains: [...new Set(dbl.map((listing) => listing.target))],
      lists: [...new Set(dbl.map((listing) => listing.list))],
      senderDomain: dbl.some((listing) => listing.target === fromOrg),
    });
  }

  const zen = spamhaus?.zen.listings ?? [];

  if (zen.length && input.intel?.ip) {
    warnings.push({
      kind: "zen_listed",
      severity: zen.some((listing) => listing.severity === "abuse")
        ? "danger"
        : "caution",
      ip: input.intel.ip,
      lists: [...new Set(zen.map((listing) => listing.list))],
    });
  }

  if (input.external) {
    const lookalike = lookalikeOf(input.fromDomain, input.workspaceDomains);

    if (lookalike) {
      warnings.push({
        kind: "lookalike_domain",
        severity: "danger",
        ...lookalike,
      });
    }

    // Someone this mailbox has written to before (a colleague's personal
    // address) is an established correspondent, not an impersonator.
    const name = impersonatedName(input.fromName, input.internalNames);

    if (name && !(input.history && input.history.outboundCount > 0)) {
      warnings.push({
        kind: "display_name_impersonation",
        severity: "danger",
        name,
      });
    }

    const claimed = embeddedAddress(input.fromName, input.fromAddress);

    if (claimed) {
      warnings.push({ kind: "embedded_address", severity: "caution", claimed });
    }
  }

  if (input.authentication?.verdict === "suspicious") {
    warnings.push({
      kind: "unverified_sender",
      severity: "caution",
      domain: input.fromDomain,
    });
  }

  const mismatch = replyToMismatch({
    fromAddress: input.fromAddress,
    replyTo: input.replyTo ?? [],
    listId: input.listId ?? null,
  });

  if (mismatch) {
    warnings.push({
      kind: "reply_to_mismatch",
      severity: "caution",
      ...mismatch,
    });
  }

  const elsewhere = addressedElsewhereWarning(
    input.delivery ?? null,
    input.fromDomain
  );

  if (elsewhere) warnings.push(elsewhere);

  return warnings
    .filter((warning) => !input.trusted || warning.severity === "danger")
    .sort((left, right) => warningOrder[left.kind] - warningOrder[right.kind]);
}

/** Gmail-style sender summary derived from the stored authentication results. */
export function messageSecurity(input: {
  fromAddress: string;
  fromName?: string | null;
  authentication: InboundAuthentication | null;
  listUnsubscribe: ListUnsubscribe | null;
  workspaceDomains: readonly string[];
  internalNames?: ReadonlyMap<string, string>;
  intel?: SenderIntel | null;
  history?: SenderHistory | null;
  replyTo?: readonly string[];
  listId?: string | null;
  delivery?: DeliveryFacts | null;
  trusted?: boolean;
}): MessageSecurity {
  const auth = input.authentication;

  const fromDomain =
    addressDomain(input.fromAddress) ?? auth?.fromDomain ?? null;

  const passing = auth?.dkim.filter((dkim) => dkim.result === "pass") ?? [];
  const alignedDkim = passing.find((dkim) => dkim.aligned);
  const signedBy = (alignedDkim ?? passing[0])?.domain ?? null;

  const mailedBy =
    auth?.spf?.domain ?? addressDomain(auth?.envelopeFrom) ?? null;

  let via: string | null = null;

  if (auth && auth.verdict !== "unavailable" && !alignedDkim) {
    const spfAligned = auth.spf?.result === "pass" && auth.spf.aligned;
    const candidate = signedBy ?? (spfAligned ? null : mailedBy);
    via =
      candidate && !relaxedAligned(candidate, fromDomain) ? candidate : null;
  }

  const external = !isWorkspaceDomain(fromDomain, input.workspaceDomains);
  const history = input.history ?? null;

  return {
    verdict: auth?.verdict ?? "unavailable",
    verdictReason: auth?.verdictReason ?? "not_cloudflare",
    fromDomain,
    mailedBy,
    signedBy,
    via,
    forwardedVia: input.delivery?.forwardedVia ?? null,
    external,
    listUnsubscribe: input.listUnsubscribe,
    warnings: securityWarnings({
      fromAddress: input.fromAddress,
      fromName: input.fromName ?? null,
      external,
      fromDomain,
      authentication: auth,
      intel: input.intel ?? null,
      workspaceDomains: input.workspaceDomains,
      internalNames: input.internalNames ?? new Map(),
      history,
      replyTo: input.replyTo,
      listId: input.listId,
      delivery: input.delivery,
      trusted: input.trusted,
    }),
    firstTimeSender: Boolean(
      !input.trusted &&
      external &&
      history &&
      history.inboundCount <= 1 &&
      history.outboundCount === 0
    ),
    replyToMismatch: replyToMismatch({
      fromAddress: input.fromAddress,
      replyTo: input.replyTo ?? [],
      listId: input.listId ?? null,
    }),
    trusted: Boolean(input.trusted),
  };
}
