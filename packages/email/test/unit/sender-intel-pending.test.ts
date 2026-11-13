import { describe, expect, it } from "bun:test";

import type { InboundAuthentication } from "@open-workspace/email/shared/mail-authentication.ts";
import type { SenderIntel } from "@open-workspace/email/shared/mail-sender-intel.ts";
import {
  SENDER_INTEL_RETRY_MS,
  senderIntelPending,
} from "@open-workspace/email/worker/mail/header-metadata.ts";
import type { Email } from "@open-workspace/email/worker/mailbox/schema.ts";

const now = 1_800_000_000_000;

function intel(status: "ok" | "timeout", checkedAt: number): SenderIntel {
  return {
    version: 1,
    source: "live",
    checkedAt,
    ip: "192.0.2.1",
    ipVersion: 4,
    ptr: { status, names: [], confirmed: null, fcrdns: null, generic: null },
    heloMatchesPtr: null,
    network: {
      status,
      asn: null,
      asName: null,
      prefix: null,
      country: null,
      registry: null,
    },
    spamhaus: null,
    bimi: null,
  };
}

const authentication: InboundAuthentication = {
  source: "headers",
  version: 1,
  authservId: "mx.cloudflare.net",
  parsedAt: now,
  remoteIp: "192.0.2.1",
  helo: null,
  envelopeFrom: null,
  fromDomain: null,
  spf: null,
  spfHelo: null,
  dkim: [],
  dmarc: null,
  arc: null,
  spamScore: null,
  verdict: "unverified",
  verdictReason: "missing_results",
  upstream: [],
  ignoredCloudflareClaims: 0,
  trustedHeader: null,
};

function email(
  senderIntelJson: SenderIntel | null,
  overrides: Partial<Email> = {}
) {
  // SAFETY: senderIntelPending reads only direction, authenticationResultsJson and senderIntelJson (with headerAuthentication); the rest of the row is never touched.
  return {
    direction: "incoming",
    authenticationResultsJson: authentication,
    senderIntelJson,
    ...overrides,
  } as Email;
}

describe("senderIntelPending", () => {
  it("needs lookups for a received message without any", () => {
    expect(senderIntelPending(email(null), now)).toBe(true);
  });

  it("keeps a stored failure until it is old enough to retry", () => {
    expect(senderIntelPending(email(intel("timeout", now - 1000)), now)).toBe(
      false
    );
    expect(
      senderIntelPending(
        email(intel("timeout", now - SENDER_INTEL_RETRY_MS)),
        now
      )
    ).toBe(true);
  });

  it("never retries a usable result", () => {
    expect(
      senderIntelPending(
        email(intel("ok", now - 10 * SENDER_INTEL_RETRY_MS)),
        now
      )
    ).toBe(false);
  });

  it("skips sent mail and messages without header authentication", () => {
    expect(
      senderIntelPending(email(null, { direction: "outgoing" }), now)
    ).toBe(false);
    expect(
      senderIntelPending(email(null, { authenticationResultsJson: null }), now)
    ).toBe(false);
  });
});
