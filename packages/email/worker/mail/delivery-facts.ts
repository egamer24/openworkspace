import type { InboundAuthentication } from "../../shared/mail-authentication";
import { addressDomain } from "../../shared/mail-headers";
import type { DeliveryFacts } from "../../shared/mail-sender-intel";
import { isWorkspaceDomain } from "./message-security";
import { organizationalDomain } from "./org-domain";

/**
 * Providers whose account and security notices are worth forging or
 * replaying: their alerts are trusted on sight and can carry text a user
 * typed into an app, device, or invoice name.
 */
const ACCOUNT_NOTICE_DOMAINS = new Set([
  "google.com",
  "apple.com",
  "icloud.com",
  "microsoft.com",
  "microsoftonline.com",
  "live.com",
  "outlook.com",
  "paypal.com",
  "amazon.com",
  "facebookmail.com",
  "instagram.com",
  "github.com",
  "docusign.net",
  "dropbox.com",
  "linkedin.com",
  "x.com",
  "coinbase.com",
  "binance.com",
]);

export function isAccountNoticeSender(fromDomain: string | null | undefined) {
  const org = organizationalDomain(fromDomain);

  return Boolean(org && ACCOUNT_NOTICE_DOMAINS.has(org));
}

/**
 * The organization that forwarded a message, when the envelope or ARC chain
 * shows a hop after the author's own servers: an SRS-rewritten envelope
 * sender, an upstream ARC chain with another organization's envelope (Gmail
 * forwarding rewrites it to `name+caf_=…@gmail.com`), or an upstream ARC set
 * sealed by someone other than the author.
 */
export function forwardingRelay(auth: InboundAuthentication | null) {
  if (!auth) return null;
  const fromOrg = organizationalDomain(auth.fromDomain);
  const envelope = auth.envelopeFrom?.toLocaleLowerCase() ?? "";
  const envelopeOrg = organizationalDomain(addressDomain(envelope));

  const foreignEnvelope =
    envelopeOrg && envelopeOrg !== fromOrg ? envelopeOrg : null;

  if (/^srs[01][=+-]/u.test(envelope) && foreignEnvelope) {
    return foreignEnvelope;
  }

  if (auth.arc && auth.arc.chainLength > 1) {
    if (foreignEnvelope) return foreignEnvelope;

    const sealer = auth.arc.sealers
      .map((item) => organizationalDomain(item.domain))
      .find((domain) => domain && domain !== fromOrg);

    if (sealer) return sealer;
  }

  return null;
}

/**
 * The first To/Cc address when the message names neither the address it was
 * delivered to nor any workspace address. Lists and undisclosed recipients
 * are left alone: they never name the reader.
 */
export function addressedElsewhere(input: {
  deliveredTo: string | null;
  to: readonly string[];
  cc: readonly string[];
  listId: string | null;
  workspaceDomains: readonly string[];
}) {
  if (input.listId) return null;

  const recipients = [...input.to, ...input.cc].flatMap((address) =>
    address.includes("@") ? [address.toLocaleLowerCase()] : []
  );

  const [firstRecipient] = recipients;

  if (firstRecipient === undefined) return null;
  const deliveredTo = input.deliveredTo?.toLocaleLowerCase();

  if (deliveredTo && recipients.includes(deliveredTo)) return null;

  if (
    recipients.some((address) =>
      isWorkspaceDomain(addressDomain(address), input.workspaceDomains)
    )
  ) {
    return null;
  }

  return firstRecipient;
}

export function deliveryFacts(input: {
  authentication: InboundAuthentication | null;
  deliveredTo: string | null;
  to: readonly string[];
  cc: readonly string[];
  listId: string | null;
  workspaceDomains: readonly string[];
  /** Whether earlier mail to the addressee already reached this mailbox from several senders. */
  isKnownAddressee: (address: string) => boolean;
}): DeliveryFacts {
  const addressedTo = addressedElsewhere(input);

  return {
    deliveredTo: input.deliveredTo?.toLocaleLowerCase() ?? null,
    addressedTo,
    knownAddressee: addressedTo ? input.isKnownAddressee(addressedTo) : false,
    forwardedVia: forwardingRelay(input.authentication),
  };
}

/**
 * The warning for mail written for someone else. Plain Bcc and newsletters
 * are not forwarded and stay quiet; a provider's account notice is suspicious
 * even without visible forwarding, because those are never Bcc'd.
 */
export function addressedElsewhereWarning(
  delivery: DeliveryFacts | null,
  fromDomain: string | null
) {
  if (!delivery?.addressedTo || delivery.knownAddressee) return null;
  const accountNotice = isAccountNoticeSender(fromDomain);

  if (!delivery.forwardedVia && !accountNotice) return null;

  // A provider forwarding its own user's mail (Gmail auto-forwarding needs the
  // target to confirm) is likely the person's own setup.
  const ownForwarding =
    delivery.forwardedVia !== null &&
    delivery.forwardedVia === organizationalDomain(delivery.addressedTo);

  return {
    kind: "addressed_elsewhere" as const,
    severity:
      accountNotice && !ownForwarding
        ? ("danger" as const)
        : ("caution" as const),
    addressedTo: delivery.addressedTo,
    forwardedVia: delivery.forwardedVia,
    accountNotice,
  };
}
