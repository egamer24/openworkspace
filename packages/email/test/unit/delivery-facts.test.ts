import { describe, expect, it } from "bun:test";

import type { InboundAuthentication } from "@open-workspace/email/shared/mail-authentication.ts";
import {
  addressedElsewhere,
  addressedElsewhereWarning,
  deliveryFacts,
  forwardingRelay,
} from "@open-workspace/email/worker/mail/delivery-facts.ts";
import { linkDomains } from "@open-workspace/email/worker/mail/link-domains.ts";
import { messageSecurity } from "@open-workspace/email/worker/mail/message-security.ts";

function auth(
  overrides: Partial<InboundAuthentication> = {}
): InboundAuthentication {
  return {
    source: "headers",
    version: 1,
    authservId: "mx.cloudflare.net",
    parsedAt: 0,
    remoteIp: "52.101.64.105",
    helo: null,
    envelopeFrom: "no-reply@accounts.google.com",
    fromDomain: "accounts.google.com",
    spf: { result: "pass", domain: "accounts.google.com", aligned: true },
    spfHelo: null,
    dkim: [
      {
        result: "pass",
        domain: "accounts.google.com",
        identity: null,
        selector: "20230601",
        bPrefix: null,
        aligned: true,
        signedHeaders: null,
      },
    ],
    dmarc: {
      result: "pass",
      headerFrom: "accounts.google.com",
      policy: "reject",
      alignedVia: ["dkim"],
    },
    arc: null,
    spamScore: null,
    verdict: "verified",
    verdictReason: "dmarc_pass",
    upstream: [],
    ignoredCloudflareClaims: 0,
    trustedHeader: null,
    ...overrides,
  };
}

// The Google app-password lure: a genuine, signed alert about the attacker's
// account, forwarded through a compromised Microsoft 365 tenant.
const forwardedAlert = auth({
  envelopeFrom: "SRS0=Ab3d=GK=accounts.google.com=no-reply@lincoln-hs.example",
  spf: { result: "softfail", domain: "lincoln-hs.example", aligned: false },
  arc: {
    result: "pass",
    chainLength: 2,
    sealers: [{ instance: 1, domain: "microsoft.com", cv: "none" }],
    oldest: null,
  },
});

describe("forwarding", () => {
  it("names the forwarder from an SRS envelope or an upstream ARC sealer", () => {
    expect(forwardingRelay(forwardedAlert)).toBe("lincoln-hs.example");
    expect(
      forwardingRelay(
        auth({
          envelopeFrom: "bounce@accounts.google.com",
          arc: {
            result: "pass",
            chainLength: 2,
            sealers: [
              { instance: 1, domain: "google.com", cv: "none" },
              { instance: 1, domain: "relay.example.org", cv: "none" },
            ],
            oldest: null,
          },
        })
      )
    ).toBe("example.org");
    // Gmail forwarding keeps Google's ARC seal but rewrites the envelope.
    expect(
      forwardingRelay(
        auth({
          envelopeFrom: "me.personal+caf_=sam=demo.example@gmail.com",
          arc: {
            result: "pass",
            chainLength: 2,
            sealers: [{ instance: 1, domain: "google.com", cv: "none" }],
            oldest: null,
          },
        })
      )
    ).toBe("gmail.com");
    expect(forwardingRelay(auth())).toBeNull();
    expect(forwardingRelay(null)).toBeNull();
  });

  it("knows when a message does not name the mailbox it reached", () => {
    const base = {
      deliveredTo: "sam@demo.example",
      cc: [],
      listId: null,
      workspaceDomains: ["demo.example"],
    };

    expect(
      addressedElsewhere({ ...base, to: ["Nadia.Orlov992@gmail.com"] })
    ).toBe("nadia.orlov992@gmail.com");
    expect(
      addressedElsewhere({ ...base, to: ["JORDAN@demo.example"] })
    ).toBeNull();
    // Workspace aliases, lists and undisclosed recipients name the reader indirectly.
    expect(
      addressedElsewhere({ ...base, to: ["team@demo.example"] })
    ).toBeNull();
    expect(
      addressedElsewhere({
        ...base,
        to: ["news@shop.example"],
        listId: "news.shop.example",
      })
    ).toBeNull();
    expect(addressedElsewhere({ ...base, to: [] })).toBeNull();
  });
});

describe("addressed elsewhere warning", () => {
  const facts = (
    overrides: {
      known?: boolean;
      to?: string;
      authentication?: InboundAuthentication;
    } = {}
  ) =>
    deliveryFacts({
      authentication: overrides.authentication ?? forwardedAlert,
      deliveredTo: "sam@demo.example",
      to: [overrides.to ?? "nadia.orlov992@gmail.com"],
      cc: [],
      listId: null,
      workspaceDomains: ["demo.example"],
      isKnownAddressee: () => overrides.known ?? false,
    });

  it("flags a forwarded account alert about someone else's account as danger, despite DMARC", () => {
    const security = messageSecurity({
      fromAddress: "no-reply@accounts.google.com",
      fromName: "Google",
      authentication: forwardedAlert,
      listUnsubscribe: null,
      workspaceDomains: ["demo.example"],
      delivery: facts(),
      // Trusting the sender does not hide it.
      trusted: true,
    });

    expect(security.verdict).toBe("verified");
    expect(security.forwardedVia).toBe("lincoln-hs.example");
    expect(security.warnings).toEqual([
      {
        kind: "addressed_elsewhere",
        severity: "danger",
        addressedTo: "nadia.orlov992@gmail.com",
        forwardedVia: "lincoln-hs.example",
        accountNotice: true,
      },
    ]);
  });

  it("stays quiet for the person's own forwarding and plain Bcc", () => {
    expect(
      addressedElsewhereWarning(facts({ known: true }), "accounts.google.com")
    ).toBeNull();
    // Newsletter Bcc: not forwarded, not an account notice.
    expect(
      addressedElsewhereWarning(
        facts({
          authentication: auth({
            fromDomain: "shop.example",
            envelopeFrom: "b@shop.example",
          }),
        }),
        "shop.example"
      )
    ).toBeNull();
    // Gmail forwarding a Gmail user's own alert is likely their own setup.
    expect(
      addressedElsewhereWarning(
        { ...facts({ to: "me@gmail.com" }), forwardedVia: "gmail.com" },
        "accounts.google.com"
      )
    ).toMatchObject({ severity: "caution" });
  });
});

describe("scheme-less links", () => {
  it("finds short links typed without a scheme, but not file names", () => {
    expect(
      linkDomains({
        text: [
          "remove it here: goo.gl/0667. Report final.pdf/2 or mail me@site.example/",
        ],
      })
    ).toEqual(["goo.gl"]);
  });
});
