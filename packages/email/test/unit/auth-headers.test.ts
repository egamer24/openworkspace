import { describe, expect, it } from "bun:test";

import {
  parseAuthenticationResults,
  parseInboundAuthentication,
  parseListUnsubscribe,
  parseReceivedSpf,
} from "@open-workspace/email/worker/mail/auth-headers.ts";
import { messageSecurity } from "@open-workspace/email/worker/mail/message-security.ts";
import { organizationalDomain } from "@open-workspace/email/worker/mail/org-domain.ts";

import genotek from "../fixtures/headers/genotek.txt" with { type: "text" };
import github from "../fixtures/headers/github.txt" with { type: "text" };
import hh from "../fixtures/headers/hh.txt" with { type: "text" };
import namecheap from "../fixtures/headers/namecheap.txt" with { type: "text" };
import playstation from "../fixtures/headers/playstation.txt" with { type: "text" };
import railway from "../fixtures/headers/railway.txt" with { type: "text" };

const NOW = Date.parse("2026-10-31T12:00:00Z");

function parse(raw: string, fromAddress: string) {
  return parseInboundAuthentication({ raw, fromAddress, now: NOW });
}

describe("RFC 8601 Authentication-Results parser", () => {
  it("keeps every result, ignores comments, and reads quoted values", () => {
    const parsed = parseAuthenticationResults(
      'mx.example.net 1 (comment; with "quotes") ; spf=pass (sender: a;b) smtp.mailfrom="x;y@example.com";' +
        " dkim=pass header.d=example.com header.s=one;" +
        ' dkim=fail reason="bad (sig)" header.i=@other.example; dmarc=pass (p=REJECT) header.from=example.com'
    );

    expect(parsed?.authservId).toBe("mx.example.net");
    expect(
      parsed?.results.map((result) => [result.method, result.result])
    ).toEqual([
      ["spf", "pass"],
      ["dkim", "pass"],
      ["dkim", "fail"],
      ["dmarc", "pass"],
    ]);
    expect(parsed?.results[0]?.props["smtp.mailfrom"]).toBe("x;y@example.com");
    expect(parsed?.results[0]?.comments).toEqual(["sender: a;b"]);
    expect(parsed?.results[2]?.reason).toBe("bad (sig)");
    expect(parsed?.results[2]?.props["header.i"]).toBe("@other.example");
  });

  it("returns no results for the `none` form", () => {
    expect(parseAuthenticationResults("mx.example.net; none")?.results).toEqual(
      []
    );
  });

  it("parses Received-SPF key-value pairs after the comment", () => {
    expect(
      parseReceivedSpf(
        'pass (mx.cloudflare.net: domain of a@b.example designates 192.0.2.1 as permitted sender) receiver=mx.cloudflare.net; client-ip=192.0.2.1; envelope-from="a@b.example"; helo=mail.b.example;'
      )
    ).toEqual({
      result: "pass",
      comment:
        "mx.cloudflare.net: domain of a@b.example designates 192.0.2.1 as permitted sender",
      pairs: {
        receiver: "mx.cloudflare.net",
        "client-ip": "192.0.2.1",
        "envelope-from": "a@b.example",
        helo: "mail.b.example",
      },
    });
  });
});

describe("organizational domains", () => {
  it("uses the Public Suffix List", () => {
    expect(organizationalDomain("cio79999.news.railway.app")).toBe(
      "railway.app"
    );
    expect(organizationalDomain("user@mail.example.co.uk")).toBe(
      "example.co.uk"
    );
    expect(organizationalDomain("s6.y.mc.salesforce.com")).toBe(
      "salesforce.com"
    );
  });
});

describe("live Cloudflare Email Routing headers", () => {
  it("Namecheap via SendGrid: SPF from smtp.mailfrom, not helo", () => {
    const auth = parse(namecheap, "renewals@namecheap.com");
    expect(auth).toMatchObject({
      authservId: "mx.cloudflare.net",
      remoteIp: "167.89.64.97",
      helo: "o4.mailservice.namecheap.com",
      envelopeFrom:
        "bounces+18856604-0811-user=example.com@mailserviceemailout1.namecheap.com",
      spf: {
        result: "pass",
        domain: "mailserviceemailout1.namecheap.com",
        aligned: true,
      },
      spfHelo: { result: "none", domain: "o4.mailservice.namecheap.com" },
      dmarc: {
        result: "pass",
        headerFrom: "namecheap.com",
        policy: "reject",
        alignedVia: ["dkim", "spf"],
      },
      arc: { result: "none", chainLength: 1, sealers: [], oldest: null },
      spamScore: 1,
      verdict: "verified",
      verdictReason: "dmarc_pass",
      upstream: [],
      ignoredCloudflareClaims: 0,
    });
    expect(auth.dkim).toEqual([
      {
        result: "pass",
        domain: "namecheap.com",
        identity: null,
        selector: "s1",
        bPrefix: "GpCZBeOu",
        aligned: true,
        signedHeaders: [
          "content-transfer-encoding",
          "content-type",
          "date",
          "from",
          "mime-version",
          "subject",
          "to",
          "cc",
          "content-type",
          "date",
          "from",
          "subject",
          "to",
        ],
      },
    ]);
    expect(auth.trustedHeader).toMatch(/^mx\.cloudflare\.net;/u);
  });

  it("GitHub: quarantine policy and aligned results", () => {
    const auth = parse(github, "noreply@github.com");
    expect(auth.dmarc?.policy).toBe("quarantine");
    expect(auth.spf).toEqual({
      result: "pass",
      domain: "github.com",
      aligned: true,
    });
    expect(
      auth.dkim.map((dkim) => [dkim.domain, dkim.selector, dkim.aligned])
    ).toEqual([["github.com", "pf2026", true]]);
    expect(auth.remoteIp).toBe("192.30.252.194");
    expect(auth.verdict).toBe("verified");
  });

  it("Railway: subdomain signatures align with the organizational domain", () => {
    const auth = parse(railway, "hello@news.railway.app");
    expect(auth.dkim[0]).toMatchObject({
      domain: "cio79999.news.railway.app",
      aligned: true,
    });
    expect(auth.spf?.aligned).toBe(true);
    expect(auth.spamScore).toBe(0);
    expect(
      messageSecurity({
        fromAddress: "hello@news.railway.app",
        authentication: auth,
        listUnsubscribe: null,
        workspaceDomains: ["example.com"],
      })
    ).toMatchObject({
      verdict: "verified",
      mailedBy: "cio79999.news.railway.app",
      signedBy: "cio79999.news.railway.app",
      via: null,
      external: true,
    });
  });

  it("Genotek: two signatures, one aligned, and a valid one-click unsubscribe", () => {
    const auth = parse(genotek, "news@genotek.ru");
    expect(auth.dkim.map((dkim) => [dkim.domain, dkim.aligned])).toEqual([
      ["genotek.ru", true],
      ["s-h-mbx-snd-0.ru", false],
    ]);
    expect(auth.spfHelo).toEqual({
      result: "pass",
      domain: "s-h-mbx-snd-0.ru",
    });
    expect(auth.dmarc?.policy).toBe("none");
    expect(auth.verdict).toBe("verified");
    expect(auth.dkim[0]?.signedHeaders).toContain("list-unsubscribe-post");
    expect(parseListUnsubscribe(genotek, auth)).toEqual({
      httpsUrl: "https://tn-dwz.s-h-mbx-trc-0.ru/ocu/-Q4BAAAAeHgBAFiT",
      mailto:
        "mailto:lu.f90e01000000787801005893@list-unsubscribe.s.mindbox.ru",
      oneClick: true,
      reason: null,
    });
  });

  it("hh.ru: an invalid List-Unsubscribe URI is never offered as one-click", () => {
    const auth = parse(hh, "noreply@hh.ru");
    expect(auth.verdict).toBe("verified");
    expect(auth.dkim[0]?.signedHeaders).toEqual([
      "date",
      "from",
      "to",
      "subject",
      "list-unsubscribe",
      "from",
    ]);
    expect(parseListUnsubscribe(hh, auth)).toEqual({
      httpsUrl: null,
      mailto: null,
      oneClick: false,
      reason: "invalid-uri",
    });
  });

  it("PlayStation: DKIM domain comes from header.i when header.d is absent", () => {
    const auth = parse(playstation, "reply@txn-email.playstation.com");
    expect(
      auth.dkim.map((dkim) => [
        dkim.domain,
        dkim.identity,
        dkim.aligned,
        dkim.signedHeaders?.length,
      ])
    ).toEqual([
      ["txn-email.playstation.com", "reply@txn-email.playstation.com", true, 9],
      ["s6.y.mc.salesforce.com", null, false, 9],
    ]);
    expect(auth.dmarc?.policy).toBe("reject");
    expect(parseListUnsubscribe(playstation, auth)).toBeNull();
  });
});

const cloudflareBlock = (
  authenticationResults: string[],
  extra: string[] = []
) => [
  "Received: from mail.sender.example (198.51.100.20)",
  "        by cloudflare-email.net (cloudflare) id TEST",
  "        for <user@example.com>; Thu, 29 Oct 2026 15:24:22 +0000",
  ...extra,
  ...authenticationResults,
  "X-CF-SpamH-Score: 4",
];

describe("trust boundary", () => {
  it("ignores a forged mx.cloudflare.net result below Cloudflare's block", () => {
    const raw = [
      ...cloudflareBlock([
        "Authentication-Results: mx.cloudflare.net;",
        "\tdkim=none; dmarc=fail header.from=bank.example policy.dmarc=none;",
        "\tspf=fail smtp.mailfrom=attacker@evil.example; arc=none smtp.remote-ip=198.51.100.20",
      ]),
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=bank.example; dmarc=pass header.from=bank.example; spf=pass smtp.mailfrom=bank.example",
      "Received-SPF: pass receiver=mx.cloudflare.net; client-ip=192.0.2.9",
      "Authentication-Results: mx.google.com; spf=pass smtp.mailfrom=bank.example; dmarc=pass header.from=bank.example",
      "From: Bank <security@bank.example>",
      "",
      "body",
    ].join("\r\n");

    const auth = parse(raw, "security@bank.example");
    expect(auth.verdict).toBe("suspicious");
    expect(auth.verdictReason).toBe("dmarc_fail");
    expect(auth.dkim).toEqual([]);
    expect(auth.spf).toEqual({
      result: "fail",
      domain: "evil.example",
      aligned: false,
    });
    expect(auth.remoteIp).toBe("198.51.100.20");
    expect(auth.spamScore).toBe(4);
    expect(auth.ignoredCloudflareClaims).toBe(2);
    expect(auth.upstream.map((claim) => claim.authservId)).toEqual([
      "mx.cloudflare.net",
      "mx.google.com",
    ]);
  });

  it("does not trust results when the top header is not Cloudflare's hop", () => {
    const raw = [
      "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=bank.example",
      ...cloudflareBlock([]),
      "From: security@bank.example",
    ].join("\r\n");

    expect(parse(raw, "security@bank.example")).toMatchObject({
      verdict: "unavailable",
      verdictReason: "not_cloudflare",
      dmarc: null,
    });
  });

  it("degrades gracefully when Cloudflare reported no Authentication-Results", () => {
    const raw = [
      ...cloudflareBlock(
        [],
        [
          'Received-SPF: none (mx.cloudflare.net: no SPF record) receiver=mx.cloudflare.net; client-ip=198.51.100.20; envelope-from="a@sender.example"; helo=mail.sender.example;',
        ]
      ),
      "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=sender.example",
      "From: a@sender.example",
    ].join("\r\n");

    expect(parse(raw, "a@sender.example")).toMatchObject({
      verdict: "unavailable",
      verdictReason: "missing_results",
      remoteIp: "198.51.100.20",
      helo: "mail.sender.example",
      envelopeFrom: "a@sender.example",
      spamScore: 4,
      dmarc: null,
      ignoredCloudflareClaims: 1,
    });
  });

  it("flags mail without any aligned pass and shows Gmail's via domain", () => {
    const raw = cloudflareBlock([
      "Authentication-Results: mx.cloudflare.net;",
      "\tdkim=pass header.d=esp-mailer.example header.s=k1;",
      "\tdmarc=none header.from=jobs.example;",
      "\tspf=pass smtp.mailfrom=bounce@esp-mailer.example; arc=none smtp.remote-ip=198.51.100.20",
    ]).join("\r\n");

    const auth = parse(raw, "alerts@jobs.example");
    expect(auth).toMatchObject({
      verdict: "suspicious",
      verdictReason: "no_aligned_pass",
    });
    expect(
      messageSecurity({
        fromAddress: "alerts@jobs.example",
        authentication: auth,
        listUnsubscribe: null,
        workspaceDomains: ["jobs.example"],
      })
    ).toMatchObject({
      via: "esp-mailer.example",
      signedBy: "esp-mailer.example",
      external: false,
    });
  });

  it("softens a DMARC failure on forwarded mail with a passing ARC chain", () => {
    const raw = [
      ...cloudflareBlock([
        "ARC-Seal: i=2; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; cv=pass; b=abc",
        "Authentication-Results: mx.cloudflare.net;",
        "\tdkim=fail header.d=northwind.example header.s=s1;",
        "\tdmarc=fail header.from=northwind.example policy.dmarc=none;",
        "\tspf=pass smtp.mailfrom=list+bounces@googlegroups.com;",
        "\tarc=pass smtp.remote-ip=198.51.100.20",
      ]),
      "ARC-Seal: i=1; a=rsa-sha256; t=1; cv=none; d=google.com; s=arc-20240605; b=def",
      "ARC-Authentication-Results: i=1; mx.google.com; dkim=pass header.d=northwind.example; spf=pass smtp.mailfrom=priya@northwind.example; dmarc=pass header.from=northwind.example",
      "From: Priya <priya@northwind.example>",
    ].join("\r\n");

    const auth = parse(raw, "priya@northwind.example");
    expect(auth.arc).toEqual({
      result: "pass",
      chainLength: 2,
      sealers: [{ instance: 1, domain: "google.com", cv: "none" }],
      oldest: {
        authservId: "mx.google.com",
        spf: "pass",
        dkim: "pass",
        dmarc: "pass",
      },
    });
    expect(auth).toMatchObject({
      verdict: "unverified",
      verdictReason: "forwarded_arc",
    });
  });
});

describe("List-Unsubscribe", () => {
  const signed = (signedHeaders: string[], aligned = true) => ({
    dkim: [
      {
        result: "pass" as const,
        domain: "news.example",
        identity: null,
        selector: "s",
        bPrefix: null,
        aligned,
        signedHeaders,
      },
    ],
  });

  const raw = (post = true) =>
    [
      "List-Unsubscribe: <mailto:leave@news.example?subject=unsubscribe>, <https://news.example/u/123>",
      ...(post ? ["List-Unsubscribe-Post: List-Unsubscribe=One-Click"] : []),
    ].join("\r\n");

  it("requires the Post header and a signature covering both headers", () => {
    expect(
      parseListUnsubscribe(raw(false), signed(["list-unsubscribe"]))?.reason
    ).toBe("no-post");
    expect(parseListUnsubscribe(raw(), { dkim: [] })?.reason).toBe("unsigned");
    expect(
      parseListUnsubscribe(raw(), signed(["list-unsubscribe"]))?.reason
    ).toBe("post-not-signed");
    expect(
      parseListUnsubscribe(
        raw(),
        signed(["list-unsubscribe", "list-unsubscribe-post"], false)
      )?.reason
    ).toBe("unaligned");
    expect(
      parseListUnsubscribe(
        raw(),
        signed(["list-unsubscribe", "list-unsubscribe-post"])
      )
    ).toEqual({
      httpsUrl: "https://news.example/u/123",
      mailto: "mailto:leave@news.example?subject=unsubscribe",
      oneClick: true,
      reason: null,
    });
  });

  it("rejects IP-literal and credentialed https links", () => {
    expect(
      parseListUnsubscribe(
        "List-Unsubscribe: <https://203.0.113.5/u>, <https://user:pw@news.example/u>",
        { dkim: [] }
      )
    ).toEqual({
      httpsUrl: null,
      mailto: null,
      oneClick: false,
      reason: "invalid-uri",
    });
  });
});
