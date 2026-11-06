import { describe, expect, it } from "vitest";
import {
  assessSpam,
  attachmentReasons,
  authenticationReasons,
  matchSenderList,
  mismatchedLink,
  normalizeSpamSenderEntry,
  parseAuthenticationResults,
  readHeaderBlock,
  relationshipReasons,
  senderListReasons,
  spamSenderCandidates,
  structureReasons,
  type AuthenticationVerdicts,
} from "../worker/mail/spam-filter";

const encoder = new TextEncoder();
const raw = (text: string) => encoder.encode(text).buffer as ArrayBuffer;
const thresholds = { spamThreshold: 70, suspiciousThreshold: 40 };
const auth = (overrides: Partial<AuthenticationVerdicts>): AuthenticationVerdicts => ({
  spf: "pass",
  dkim: "pass",
  dmarc: "pass",
  dmarcPolicyNone: false,
  ...overrides,
});
const points = (reasons: Array<{ points: number }>) =>
  reasons.reduce((total, reason) => total + reason.points, 0);
const baseInput = {
  authentication: null,
  relationship: { address: false, domain: false },
  senderList: null,
  from: { address: "sender@example.net", name: "Sender" },
  recipientCount: 1,
  html: null,
  hasTextPart: true,
  attachments: [],
};

describe("header block", () => {
  it("unfolds headers and stops at the body", () => {
    const headers = readHeaderBlock(raw([
      "Authentication-Results: mx.example;",
      "\tdmarc=pass header.from=example.net",
      "Subject: Hi",
      "",
      "Authentication-Results: body; dmarc=fail",
    ].join("\r\n")));
    expect(headers).toEqual([
      { name: "authentication-results", value: "mx.example; dmarc=pass header.from=example.net" },
      { name: "subject", value: "Hi" },
    ]);
  });

  it("reads at most 64 KB", () => {
    const headers = readHeaderBlock(raw(
      `X-Padding: ${"a".repeat(70 * 1024)}\r\nAuthentication-Results: mx; dmarc=fail\r\n\r\nbody`,
    ));
    expect(headers.map((header) => header.name)).toEqual(["x-padding"]);
  });
});

describe("authentication results", () => {
  it("trusts the topmost Authentication-Results header", () => {
    const results = parseAuthenticationResults(readHeaderBlock(raw([
      "Authentication-Results: mx.cloudflare.net; dkim=fail header.d=a.test; dkim=pass header.d=b.test; spf=softfail smtp.mailfrom=a.test; dmarc=fail (p=NONE) header.from=a.test",
      "Authentication-Results: forged.example; dmarc=pass",
      "",
      "",
    ].join("\r\n"))));
    expect(results).toEqual({ spf: "softfail", dkim: "pass", dmarc: "fail", dmarcPolicyNone: true });
  });

  it("ignores results not written by Cloudflare, including ARC", () => {
    const parse = (lines: string[]) =>
      parseAuthenticationResults(readHeaderBlock(raw([...lines, "", ""].join("\r\n"))));
    // A sender-supplied header on top (no Cloudflare header) is not trusted.
    expect(parse(["Authentication-Results: mx.cloudflare.net.evil.example; dmarc=pass"])).toBeNull();
    expect(parse(["Authentication-Results: forged.example; dmarc=pass"])).toBeNull();
    expect(parse([
      "ARC-Authentication-Results: i=2; mx.two; dmarc=pass",
      "Received: from x",
    ])).toBeNull();
    // An authserv-id may carry a version token.
    expect(parse(["Authentication-Results: mx.cloudflare.net 1; dmarc=fail"]))
      .toMatchObject({ dmarc: "fail" });
  });

  it("returns nothing without results", () => {
    expect(parseAuthenticationResults(readHeaderBlock(raw("Subject: x\r\n\r\n")))).toBeNull();
    expect(authenticationReasons(null)).toEqual([]);
  });

  it("weighs DMARC failure most and lowers the score for an aligned pass", () => {
    expect(points(authenticationReasons(auth({ dmarc: "fail", spf: "pass", dkim: "pass" })))).toBe(45);
    expect(points(authenticationReasons(auth({ dmarc: "fail", dmarcPolicyNone: true })))).toBe(25);
    expect(points(authenticationReasons(auth({ dmarc: "none", spf: "fail", dkim: "pass" })))).toBe(15);
    expect(points(authenticationReasons(auth({ dmarc: "none", spf: "pass", dkim: "fail" })))).toBe(15);
    expect(points(authenticationReasons(auth({})))).toBe(-15);
    expect(points(authenticationReasons(auth({ dmarc: "none", spf: "none", dkim: "none" })))).toBe(10);
  });
});

describe("sender relationship", () => {
  it("strongly lowers the score for known correspondents", () => {
    expect(points(relationshipReasons({ address: true, domain: true }, "a@partner.example", null))).toBe(-40);
    expect(points(relationshipReasons({ address: false, domain: true }, "b@partner.example", null))).toBe(-20);
    expect(relationshipReasons({ address: false, domain: false }, "c@partner.example", null)).toEqual([]);
  });

  it("ignores shared consumer domains and spoofed senders", () => {
    expect(relationshipReasons({ address: false, domain: true }, "x@gmail.com", null)).toEqual([]);
    expect(relationshipReasons({ address: true, domain: true }, "a@partner.example", auth({ dmarc: "fail" }))).toEqual([]);
  });
});

describe("sender lists", () => {
  it("matches the address, its domain, and parent domains", () => {
    expect(spamSenderCandidates("Bob@Mail.Partner.Example")).toEqual([
      "bob@mail.partner.example",
      "mail.partner.example",
      "partner.example",
    ]);
  });

  it("lets the allow list win", () => {
    expect(matchSenderList(["block", "allow"])).toBe("allow");
    expect(matchSenderList(["block"])).toBe("block");
    expect(matchSenderList([])).toBeNull();
    expect(points(senderListReasons("block"))).toBe(100);
    expect(points(senderListReasons("allow"))).toBe(-100);
  });

  it("normalizes entries", () => {
    expect(normalizeSpamSenderEntry(" Bob@Example.COM ")).toBe("bob@example.com");
    expect(normalizeSpamSenderEntry("@Example.com")).toBe("example.com");
    expect(normalizeSpamSenderEntry("*.example.com")).toBe("example.com");
    expect(normalizeSpamSenderEntry("example")).toBeNull();
    expect(normalizeSpamSenderEntry("not an address@x")).toBeNull();
  });
});

describe("structure heuristics", () => {
  it("flags a display name that shows a different address", () => {
    const reasons = structureReasons({
      from: { address: "x@evil.example", name: "billing@bank.example" },
      recipientCount: 1,
      html: null,
      hasTextPart: true,
    });
    expect(points(reasons)).toBe(25);
    expect(structureReasons({
      from: { address: "billing@bank.example", name: "Billing@Bank.example" },
      recipientCount: 1,
      html: null,
      hasTextPart: true,
    })).toEqual([]);
  });

  it("flags HTML-only messages and long recipient lists", () => {
    expect(points(structureReasons({ ...baseInput, html: "<p>Hi</p>", hasTextPart: false }))).toBe(8);
    expect(points(structureReasons({ ...baseInput, recipientCount: 26 }))).toBe(10);
    expect(structureReasons({ ...baseInput, recipientCount: 25 })).toEqual([]);
  });

  it("detects links whose text names another domain", () => {
    expect(mismatchedLink(
      '<a href="https://evil.example/login"><b>www.bank.example</b></a>',
    )).toEqual({ textHost: "www.bank.example", hrefHost: "evil.example" });
    expect(mismatchedLink('<a href="https://www.bank.example/x">bank.example</a>')).toBeNull();
    expect(mismatchedLink("<a href='https://evil.example'>Sign in</a>")).toBeNull();
    expect(mismatchedLink('<a href="mailto:a@b.example">c.example</a>')).toBeNull();
  });
});

describe("attachment risk", () => {
  it("scores each risky category once", () => {
    const reasons = attachmentReasons([
      { filename: "invoice.pdf.exe" },
      { filename: "setup.EXE" },
      { filename: "report.xlsm" },
      { filename: "photos.zip" },
      { filename: "notes.pdf" },
    ]);
    expect(reasons.map((reason) => reason.points)).toEqual([40, 20, 10]);
    expect(reasons[0]!.reason).toContain("invoice.pdf.exe");
    expect(attachmentReasons([{ filename: "notes.docx" }])).toEqual([]);
  });
});

describe("assessment", () => {
  it("maps scores to threshold bands", () => {
    expect(assessSpam(baseInput, thresholds)).toMatchObject({ score: 0, verdict: "clean" });
    expect(assessSpam({
      ...baseInput,
      authentication: auth({ dmarc: "fail" }),
    }, thresholds)).toMatchObject({ score: 45, verdict: "suspicious" });
    expect(assessSpam({
      ...baseInput,
      authentication: auth({ dmarc: "fail", spf: "fail", dkim: "fail" }),
    }, thresholds)).toMatchObject({ score: 75, verdict: "spam" });
    expect(assessSpam({
      ...baseInput,
      authentication: auth({ dmarc: "fail" }),
    }, { spamThreshold: 45, suspiciousThreshold: 10 })).toMatchObject({ verdict: "spam" });
  });

  it("clamps the score and applies list precedence", () => {
    const risky = {
      ...baseInput,
      authentication: auth({ dmarc: "fail", spf: "fail", dkim: "fail" }),
      attachments: [{ filename: "a.exe" }],
    };
    expect(assessSpam({ ...risky, senderList: "allow" }, thresholds)).toMatchObject({
      score: 15,
      verdict: "clean",
      senderList: "allow",
    });
    expect(assessSpam({
      ...baseInput,
      authentication: auth({}),
      relationship: { address: true, domain: true },
      senderList: "block",
    }, thresholds)).toMatchObject({ score: 45, verdict: "spam" });
    expect(assessSpam({ ...risky, senderList: "block" }, thresholds).score).toBe(100);
  });
});
