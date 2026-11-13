import { describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import type { InboundAuthentication } from "@open-workspace/email/shared/mail-authentication.ts";
import type { SenderIntel } from "@open-workspace/email/shared/mail-sender-intel.ts";
import { classificationSignals } from "@open-workspace/email/worker/mail/classification-signals.ts";
import {
  confusableSkeleton,
  decodePunycodeLabel,
  domainToUnicode,
  embeddedAddress,
  impersonatedName,
  levenshtein,
  lookalikeOf,
  protectedNames,
} from "@open-workspace/email/worker/mail/impersonation.ts";
import { messageSecurity } from "@open-workspace/email/worker/mail/message-security.ts";

const workspace = ["demo.example", "northwind.com"];

const names = protectedNames([
  "Maya Chen",
  "Sam Brooks",
  "Support",
  "  Alex   Rivera ",
]);

function intel(overrides: Partial<SenderIntel> = {}): SenderIntel {
  return {
    version: 1,
    source: "live",
    checkedAt: 0,
    ip: "198.51.100.7",
    ipVersion: 4,
    ptr: {
      status: "ok",
      names: ["mx.sender.example"],
      confirmed: "mx.sender.example",
      fcrdns: true,
      generic: false,
    },
    heloMatchesPtr: true,
    network: {
      status: "ok",
      asn: 64_500,
      asName: "Example Net",
      prefix: "198.51.100.0/24",
      country: "US",
      registry: "arin",
    },
    spamhaus: null,
    bimi: null,
    ...overrides,
  };
}

const suspicious: InboundAuthentication = {
  source: "headers",
  version: 1,
  authservId: "mx.cloudflare.net",
  parsedAt: 0,
  remoteIp: null,
  helo: null,
  envelopeFrom: null,
  fromDomain: null,
  spfHelo: null,
  arc: null,
  upstream: [],
  ignoredCloudflareClaims: 0,
  trustedHeader: null,
  verdict: "suspicious",
  verdictReason: "dmarc_fail",
  spf: { result: "fail", domain: "x.example", aligned: false },
  dkim: [],
  dmarc: {
    result: "fail",
    headerFrom: "x.example",
    policy: "none",
    alignedVia: [],
  },
  spamScore: 4,
};

describe("punycode and confusables", () => {
  it("decodes punycode labels", () => {
    expect(decodePunycodeLabel("mnchen-3ya")).toBe("münchen");
    expect(domainToUnicode(new URL("http://dеmo.example").hostname)).toBe(
      "dеmo.example"
    );
    expect(decodePunycodeLabel("!!")).toBeNull();
  });

  it("folds homoglyphs into one skeleton", () => {
    expect(confusableSkeleton("dеmо")).toBe(confusableSkeleton("demo"));
    expect(confusableSkeleton("examp1e")).toBe(confusableSkeleton("example"));
    expect(confusableSkeleton("rnicrosoft")).toBe(
      confusableSkeleton("microsoft")
    );
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

describe("lookalike domains", () => {
  it.each([
    ["demo-examp1e.com", "demo.example"],
    ["demo.co", "demo.example"],
    [new URL("http://dеmo.example").hostname, "demo.example"],
    ["northwlnd.com", "northwind.com"],
    ["nortwind.com", "northwind.com"],
    ["north-wind.io", "northwind.com"],
  ])("%s resembles %s", (domain, resembles) => {
    expect(lookalikeOf(domain, workspace)).toMatchObject({ resembles });
  });

  it.each([
    "demo.example",
    "mail.demo.example",
    "google.com",
    "northwestern.edu",
    "mode.example.org",
    null,
  ])("%s is not a lookalike", (domain) => {
    expect(lookalikeOf(domain, workspace)).toBeNull();
  });

  it("shows the Unicode form of punycode lookalikes", () => {
    expect(
      lookalikeOf(new URL("http://dеmo.example").hostname, workspace)?.domain
    ).toBe("dеmo.example");
  });
});

describe("display names", () => {
  it("matches only multi-word internal names, ignoring case and punctuation", () => {
    expect(impersonatedName("maya  CHEN", names)).toBe("Maya Chen");
    expect(impersonatedName("Maya Chen (via Freemail)", names)).toBeNull();
    expect(impersonatedName("Support", names)).toBeNull();
    expect(impersonatedName("Alex Rivera", names)).toBe("Alex Rivera");
  });

  it("finds an address in the display name that differs from the sender", () => {
    expect(embeddedAddress("ceo@demo.example", "x@elsewhere.example")).toBe(
      "ceo@demo.example"
    );
    expect(
      embeddedAddress("x@elsewhere.example", "X@elsewhere.example")
    ).toBeNull();
    expect(embeddedAddress("Maya Chen", "x@elsewhere.example")).toBeNull();
  });
});

describe("security warnings", () => {
  const base = {
    listUnsubscribe: null,
    workspaceDomains: workspace,
    internalNames: names,
    authentication: null,
  };

  it("flags an external sender using an internal name, unless the mailbox wrote to them", () => {
    const first = messageSecurity({
      ...base,
      fromAddress: "maya.chen.desk@freemail.example",
      fromName: "Maya Chen",
      history: { inboundCount: 1, outboundCount: 0 },
    });

    expect(first.warnings).toEqual([
      {
        kind: "display_name_impersonation",
        severity: "danger",
        name: "Maya Chen",
      },
    ]);
    expect(first.firstTimeSender).toBe(true);

    const known = messageSecurity({
      ...base,
      fromAddress: "maya.chen.desk@freemail.example",
      fromName: "Maya Chen",
      history: { inboundCount: 4, outboundCount: 2 },
    });

    expect(known.warnings).toEqual([]);
    expect(known.firstTimeSender).toBe(false);

    const internal = messageSecurity({
      ...base,
      fromAddress: "maya@demo.example",
      fromName: "Maya Chen",
      history: null,
    });

    expect(internal.warnings).toEqual([]);
    expect(internal.firstTimeSender).toBe(false);
  });

  it("orders blocklist, lookalike and unverified warnings by severity", () => {
    const security = messageSecurity({
      ...base,
      authentication: suspicious,
      fromAddress: "it-support@demo-examp1e.com",
      fromName: "it@demo.example",
      intel: intel({
        spamhaus: {
          zen: {
            status: "ok",
            error: null,
            listings: [
              {
                zone: "zen",
                target: "198.51.100.7",
                code: "127.0.0.11",
                list: "PBL (end-user range)",
                severity: "policy",
              },
            ],
          },
          dbl: {
            status: "ok",
            error: null,
            domains: ["demo-examp1e.com"],
            listings: [
              {
                zone: "dbl",
                target: "demo-examp1e.com",
                code: "127.0.1.4",
                list: "DBL phishing domain",
                severity: "abuse",
              },
            ],
          },
        },
      }),
      history: null,
    });

    expect(
      security.warnings.map((warning) => [warning.kind, warning.severity])
    ).toEqual([
      ["dbl_listed", "danger"],
      ["lookalike_domain", "danger"],
      ["zen_listed", "caution"],
      ["unverified_sender", "caution"],
      ["embedded_address", "caution"],
    ]);
  });

  it("summarizes receiver signals for the classifier", () => {
    const security = messageSecurity({
      ...base,
      authentication: suspicious,
      fromAddress: "maya.chen@freemail.example",
      fromName: "Maya Chen",
      intel: intel({
        ptr: {
          status: "ok",
          names: ["1-2-3-4.dsl.example"],
          confirmed: null,
          fcrdns: false,
          generic: true,
        },
      }),
      history: { inboundCount: 1, outboundCount: 0 },
    });

    expect(
      classificationSignals({
        authentication: suspicious,
        intel: intel({
          ptr: {
            status: "ok",
            names: ["1-2-3-4.dsl.example"],
            confirmed: null,
            fcrdns: false,
            generic: true,
          },
        }),
        firstTimeSender: security.firstTimeSender,
        warnings: security.warnings,
      })
    ).toEqual({
      authentication: {
        verdict: "suspicious",
        spf: "fail",
        dkimAlignedPass: false,
        dmarc: "fail",
        dmarcPolicy: "none",
      },
      cloudflareSpamScore: 4,
      sendingServer: {
        ip: "198.51.100.7",
        ptr: "1-2-3-4.dsl.example",
        forwardConfirmed: false,
        genericPtr: true,
        heloMatchesPtr: true,
        asn: 64_500,
        asOrganization: "Example Net",
        country: "US",
      },
      blocklists: null,
      firstTimeSender: true,
      warnings: ["display_name_impersonation", "unverified_sender"],
      userFeedback: null,
      workspaceFeedback: null,
      delivery: null,
    });
  });
});

describe("demo seed", () => {
  it("exercises impersonation, lookalike, blocklist and BIMI cases with pre-computed intel", async () => {
    const { demoMailboxEmails, demoMailboxObjects } =
      await import("@open-workspace/email/worker/mailbox/demo.ts");

    const emails = demoMailboxEmails("mbx_demo_personal", 1_800_000_000_000);

    const security = (id: string) => {
      const email = required(
        emails.find((item) => item.id === id),
        `demo message ${id}`
      );

      const from = required(email.fromJson[0], `${id}'s From`);

      return messageSecurity({
        fromAddress: from.address,
        fromName: from.name,
        authentication:
          email.authenticationResultsJson?.source === "headers"
            ? email.authenticationResultsJson
            : null,
        listUnsubscribe: null,
        workspaceDomains: ["demo.example"],
        internalNames: protectedNames(["Maya Chen", "Sam Brooks"]),
        intel: email.senderIntelJson ?? null,
        history: { inboundCount: 1, outboundCount: 0 },
      });
    };

    expect(
      security("msg_demo_15").warnings.map((warning) => warning.kind)
    ).toEqual(["display_name_impersonation"]);
    expect(
      security("msg_demo_16").warnings.map((warning) => warning.kind)
    ).toEqual(["dbl_listed", "lookalike_domain"]);
    expect(security("msg_demo_17").warnings).toEqual([]);
    expect(
      emails.find((item) => item.id === "msg_demo_18")?.senderIntelJson?.bimi
    ).toMatchObject({ status: "ok" });

    const { validateBimiSvg } =
      await import("@open-workspace/email/worker/mail/bimi.ts");

    const logo = demoMailboxObjects("mbx_demo_personal").find(
      (object) => object.key === "bimi/v1/orbitalcloud.example.svg"
    );

    expect(
      validateBimiSvg(required(logo, "the demo BIMI logo").body)
    ).toHaveProperty("svg");

    for (const email of emails) {
      if (email.senderIntelJson) {
        expect(email.senderIntelJson.source).toBe("demo");
      }
    }
  });
});
