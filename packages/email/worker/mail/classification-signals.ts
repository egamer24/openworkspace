import type { InboundAuthentication } from "../../shared/mail-authentication";
import type {
  DeliveryFacts,
  SecurityWarning,
  SenderIntel,
} from "../../shared/mail-sender-intel";

/** Compact, model-facing summary of what the receiver measured for a message. */
export type ClassificationSignals = {
  authentication: {
    verdict: InboundAuthentication["verdict"];
    spf: string | null;
    dkimAlignedPass: boolean;
    dmarc: string | null;
    dmarcPolicy: string | null;
  } | null;
  cloudflareSpamScore: number | null;
  sendingServer: {
    ip: string;
    ptr: string | null;
    forwardConfirmed: boolean | null;
    genericPtr: boolean | null;
    heloMatchesPtr: boolean | null;
    asn: number | null;
    asOrganization: string | null;
    country: string | null;
  } | null;
  blocklists: {
    zen: string[];
    dbl: { domain: string; list: string }[];
  } | null;
  firstTimeSender: boolean | null;
  warnings: SecurityWarning["kind"][];
  /** What people in this mailbox reported about the sender before (counts). */
  userFeedback: {
    spamReports: number;
    notSpam: number;
    /** Spam reports about other addresses at the same domain. */
    domainReports: number;
  } | null;
  /** Who the message was written for, the address it reached, and who forwarded it. */
  delivery: {
    deliveredTo: string | null;
    addressedToThisMailbox: boolean;
    addressedTo: string | null;
    knownAddressee: boolean;
    forwardedVia: string | null;
  } | null;
  /** The same counts from every other mailbox in the workspace. */
  workspaceFeedback: {
    spamReports: number;
    notSpam: number;
    domainReports: number;
    reportingMailboxes: number;
  } | null;
};

export function classificationSignals(input: {
  authentication: InboundAuthentication | null;
  intel: SenderIntel | null;
  firstTimeSender: boolean | null;
  warnings: SecurityWarning[];
  feedback?: ClassificationSignals["userFeedback"];
  workspaceFeedback?: ClassificationSignals["workspaceFeedback"];
  delivery?: DeliveryFacts | null;
}): ClassificationSignals {
  const auth = input.authentication;
  const { intel } = input;

  return {
    authentication:
      auth && auth.verdict !== "unavailable"
        ? {
            verdict: auth.verdict,
            spf: auth.spf?.result ?? null,
            dkimAlignedPass: auth.dkim.some(
              (dkim) => dkim.result === "pass" && dkim.aligned
            ),
            dmarc: auth.dmarc?.result ?? null,
            dmarcPolicy: auth.dmarc?.policy ?? null,
          }
        : null,
    cloudflareSpamScore: auth?.spamScore ?? null,
    sendingServer: intel?.ip
      ? {
          ip: intel.ip,
          ptr: intel.ptr.confirmed ?? intel.ptr.names[0] ?? null,
          forwardConfirmed: intel.ptr.fcrdns,
          genericPtr: intel.ptr.generic,
          heloMatchesPtr: intel.heloMatchesPtr,
          asn: intel.network.asn,
          asOrganization: intel.network.asName,
          country: intel.network.country,
        }
      : null,
    blocklists: intel?.spamhaus
      ? {
          zen: intel.spamhaus.zen.listings.map((listing) => listing.list),
          dbl: intel.spamhaus.dbl.listings.map((listing) => ({
            domain: listing.target,
            list: listing.list,
          })),
        }
      : null,
    firstTimeSender: input.firstTimeSender,
    warnings: input.warnings.map((warning) => warning.kind),
    userFeedback:
      input.feedback && Object.values(input.feedback).some((count) => count > 0)
        ? input.feedback
        : null,
    delivery: input.delivery
      ? {
          deliveredTo: input.delivery.deliveredTo,
          addressedToThisMailbox: !input.delivery.addressedTo,
          addressedTo: input.delivery.addressedTo,
          knownAddressee: input.delivery.knownAddressee,
          forwardedVia: input.delivery.forwardedVia,
        }
      : null,
    workspaceFeedback:
      input.workspaceFeedback &&
      Object.values(input.workspaceFeedback).some((count) => count > 0)
        ? input.workspaceFeedback
        : null,
  };
}
