import { describe, expect, test } from "bun:test";

import {
  describeMx,
  findAccount,
  foreignMx,
  hostnameProblem,
  normalizeDomain,
  parseDomainList,
  primaryFirst,
  suggestedHostname,
  zoneOf,
  zonesNamed,
} from "../../setup/domains.ts";

const zones = [
  { id: "z1", name: "acme.com", status: "active" },
  { id: "z2", name: "acme.org", status: "active" },
  { id: "z3", name: "eu.acme.com", status: "pending" },
];

describe("mail domains", () => {
  test("parse a comma or space separated list, lowercased", () => {
    expect(parseDomainList("Acme.com, acme.org  example.net.")).toEqual([
      "acme.com",
      "acme.org",
      "example.net",
    ]);
    expect(parseDomainList(" , ")).toEqual([]);
    expect(normalizeDomain(" Mail.Acme.COM. ")).toBe("mail.acme.com");
  });

  test("must be zones of the account, kept in the order given", () => {
    expect(zonesNamed(["acme.org", "ACME.com", "acme.org"], zones)).toEqual({
      found: [zones[1], zones[0]],
      missing: [],
    });
    expect(
      zonesNamed(["acme.com", "other.com", "mail.acme.com"], zones)
    ).toEqual({
      found: [zones[0]],
      missing: ["other.com", "mail.acme.com"],
    });
  });

  test("put the primary first and keep the rest in order", () => {
    expect(primaryFirst(["a.com", "b.com", "c.com"], "b.com")).toEqual([
      "b.com",
      "a.com",
      "c.com",
    ]);
    expect(primaryFirst(["a.com"], "a.com")).toEqual(["a.com"]);
  });
});

describe("hostname", () => {
  test("is suggested as mail.<primary>", () => {
    expect(suggestedHostname("acme.com")).toBe("mail.acme.com");
  });

  test("belongs to the longest zone it is in", () => {
    expect(zoneOf("mail.acme.com", zones)?.name).toBe("acme.com");
    expect(zoneOf("mail.eu.acme.com", zones)?.name).toBe("eu.acme.com");
    expect(zoneOf("acme.org", zones)?.name).toBe("acme.org");
    expect(zoneOf("notacme.com", zones)).toBeUndefined();
  });

  test("must be a hostname in one of the account's zones", () => {
    expect(hostnameProblem("mail.acme.com", zones)).toBeUndefined();
    expect(hostnameProblem("Mail.Acme.org", zones)).toBeUndefined();
    expect(hostnameProblem("acme.com", zones)).toBeUndefined();
    expect(hostnameProblem("mail.other.com", zones)).toBe(
      "mail.other.com isn't in a zone of this account (acme.com, acme.org, eu.acme.com)"
    );
    expect(hostnameProblem("mail_acme", zones)).toBe(
      "Use a hostname such as mail.acme.com"
    );
    expect(hostnameProblem("https://mail.acme.com", zones)).toBe(
      "Use a hostname such as mail.acme.com"
    );
  });
});

describe("MX records", () => {
  const google = [
    { name: "acme.com", content: "aspmx.l.google.com", priority: 1 },
    { name: "acme.com", content: "alt1.aspmx.l.google.com", priority: 5 },
  ];

  const routing = [
    { name: "acme.com", content: "route1.mx.cloudflare.net", priority: 12 },
    { name: "acme.com", content: "route2.mx.cloudflare.net.", priority: 35 },
  ];

  test("of Email Routing are not another provider's", () => {
    expect(foreignMx(routing)).toEqual([]);
    expect(foreignMx([])).toEqual([]);
  });

  test("of another provider are found, next to Email Routing's too", () => {
    expect(foreignMx([...routing, ...google])).toEqual(google);
    expect(
      foreignMx([
        {
          name: "acme.com",
          content: "mx.cloudflare.net.evil.com",
          priority: 1,
        },
      ])
    ).toHaveLength(1);
  });

  test("are described by priority", () => {
    expect(describeMx([...google].reverse())).toEqual([
      "acme.com  MX 1 aspmx.l.google.com",
      "acme.com  MX 5 alt1.aspmx.l.google.com",
    ]);
  });
});

describe("--account", () => {
  const accounts = [
    { id: "0123456789abcdef0123456789abcdef", name: "Acme" },
    { id: "fedcba9876543210fedcba9876543210", name: "Acme Staging" },
  ];

  test("names an account by id or by name, ignoring case", () => {
    expect(
      findAccount(accounts, "FEDCBA9876543210FEDCBA9876543210")?.name
    ).toBe("Acme Staging");
    expect(findAccount(accounts, "acme staging")?.name).toBe("Acme Staging");
    expect(findAccount(accounts, " Acme ")?.name).toBe("Acme");
    expect(findAccount(accounts, "Other")).toBeUndefined();
  });
});
