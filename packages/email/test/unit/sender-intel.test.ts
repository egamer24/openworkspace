import { describe, expect, it } from "bun:test";

import type { InboundAuthentication } from "@open-workspace/email/shared/mail-authentication.ts";
import { countryFlag } from "@open-workspace/email/shared/mail-sender-intel.ts";
import {
  parseBimiRecord,
  validateBimiSvg,
} from "@open-workspace/email/worker/mail/bimi.ts";
import {
  createDohResolver,
  txtData,
} from "@open-workspace/email/worker/mail/doh.ts";
import type {
  DnsAnswer,
  DnsResolver,
} from "@open-workspace/email/worker/mail/doh.ts";
import type { IpIntel } from "@open-workspace/email/worker/mail/ip-intel.ts";
import {
  isGenericPtr,
  lookupIpIntel,
  parseCymruAsName,
  parseCymruOrigin,
  reverseDnsName,
} from "@open-workspace/email/worker/mail/ip-intel.ts";
import { linkDomains } from "@open-workspace/email/worker/mail/link-domains.ts";
import { collectSenderIntel } from "@open-workspace/email/worker/mail/sender-intel.ts";
import type { IntelCache } from "@open-workspace/email/worker/mail/sender-intel.ts";
import {
  checkSpamhaus,
  spamhausErrorCode,
} from "@open-workspace/email/worker/mail/spamhaus.ts";

const KEY = "abcdefghijklmnopqrstuvwxyz";

/**
 * The mail bucket, which these lookups never reach: BIMI runs only after an
 * enforcing DMARC pass. The BIMI cache in R2 is tested on the stack
 * (test/stack/sender-intel.test.ts).
 */
// SAFETY: every property read on the proxy throws before the empty target is consulted, so no R2Bucket member is ever used.
const unusedBucket = new Proxy({} as R2Bucket, {
  get: (_, method) => () => {
    throw new Error(`The mail bucket must not be used (${String(method)})`);
  },
});

/** A stand-in for the Worker's fetch. */
const fakeFetch = (
  fetcher: (url: RequestInfo | URL) => Promise<Response>
): typeof fetch => Object.assign(fetcher, { preconnect: fetch.preconnect });

function fakeResolver(
  table: Record<string, string[] | "nxdomain" | "hang">
): DnsResolver & { queries: string[] } {
  const queries: string[] = [];

  const resolve = (name: string, type: string): Promise<DnsAnswer> => {
    queries.push(`${type} ${name}`);
    const entry = table[`${type} ${name}`];

    if (entry === "hang") return new Promise(() => {});

    if (!entry || entry === "nxdomain") {
      return Promise.resolve({ status: "nxdomain", records: [] });
    }

    return Promise.resolve({ status: "ok", records: entry });
  };

  return Object.assign(resolve, { queries });
}

function memoryCache(): IntelCache & { store: Map<string, IpIntel> } {
  const store = new Map<string, IpIntel>();

  return {
    store,
    get(ip) {
      return Promise.resolve(store.get(ip) ?? null);
    },
    put(ip, intel) {
      store.set(ip, intel);

      return Promise.resolve();
    },
  };
}

function authentication(
  overrides: Partial<InboundAuthentication> = {}
): InboundAuthentication {
  return {
    source: "headers",
    version: 1,
    authservId: "mx.cloudflare.net",
    parsedAt: 0,
    remoteIp: "8.8.4.4",
    helo: "mail-out.sender.example",
    envelopeFrom: "bounce@sender.example",
    fromDomain: "sender.example",
    spf: { result: "pass", domain: "sender.example", aligned: true },
    spfHelo: null,
    dkim: [],
    dmarc: {
      result: "pass",
      headerFrom: "sender.example",
      policy: "reject",
      alignedVia: ["spf"],
    },
    arc: null,
    spamScore: 0,
    verdict: "verified",
    verdictReason: "dmarc_pass",
    upstream: [],
    ignoredCloudflareClaims: 0,
    trustedHeader: null,
    ...overrides,
  };
}

const senderTable = {
  "PTR 4.4.8.8.in-addr.arpa": ["mail-out.sender.example"],
  "A mail-out.sender.example": ["8.8.4.4"],
  "TXT 4.4.8.8.origin.asn.cymru.com": [
    "15169 | 8.8.4.0/24 | US | arin | 1992-12-01",
  ],
  "TXT AS15169.asn.cymru.com": [
    "15169 | US | arin | 2000-03-30 | GOOGLE - Google LLC, US",
  ],
};

describe("DNS-over-HTTPS client", () => {
  it("parses JSON answers, joins TXT strings and reports NXDOMAIN", async () => {
    const requests: string[] = [];

    const resolve = createDohResolver({
      fetch: fakeFetch((url) => {
        requests.push(String(url));
        const name = new URL(String(url)).searchParams.get("name");

        if (name === "missing.example") {
          return Promise.resolve(Response.json({ Status: 3 }));
        }

        return Promise.resolve(
          Response.json({
            Status: 0,
            Answer: [
              { type: 5, data: "alias.example." },
              { type: 16, data: '"v=BIMI1; " "l=https://a.example/logo.svg"' },
            ],
          })
        );
      }),
    });

    expect(await resolve("default._bimi.a.example", "TXT")).toEqual({
      status: "ok",
      records: ["v=BIMI1; l=https://a.example/logo.svg"],
    });
    expect(await resolve("missing.example", "A")).toEqual({
      status: "nxdomain",
      records: [],
    });
    expect(requests[0]).toBe(
      "https://cloudflare-dns.com/dns-query?name=default._bimi.a.example&type=TXT"
    );
    expect(txtData('"a\\"b"')).toBe('a"b');
  });

  it("maps aborts to timeout and other failures to error", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await createDohResolver({
        signal: controller.signal,
        fetch: fakeFetch(() => Promise.reject(new Error("x"))),
      })("a.example", "A")
    ).toEqual({ status: "timeout", records: [] });
    expect(
      await createDohResolver({
        fetch: fakeFetch(() => Promise.reject(new Error("down"))),
      })("a.example", "A")
    ).toEqual({ status: "error", records: [] });
    expect(
      await createDohResolver({
        fetch: fakeFetch(() =>
          Promise.resolve(new Response("no", { status: 502 }))
        ),
      })("a.example", "A")
    ).toEqual({ status: "error", records: [] });
  });
});

describe("IP intelligence", () => {
  it("builds reverse names for IPv4 and IPv6", () => {
    expect(reverseDnsName("192.0.2.10")).toBe("10.2.0.192.in-addr.arpa");
    expect(reverseDnsName("2001:db8::1")).toBe(
      "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa"
    );
  });

  it("recognises generic access-network PTR names", () => {
    expect(
      isGenericPtr("77-2-0-192.dyn.broadband-pool.example", "192.0.2.77")
    ).toBe(true);
    expect(
      isGenericPtr("c-203-0-113-9.hsd1.ca.cable.example.net", "203.0.113.9")
    ).toBe(true);
    expect(
      isGenericPtr("ec2-54-1-2-3.compute-1.amazonaws.com", "54.1.2.3")
    ).toBe(true);
    expect(isGenericPtr("mail-sor-f69.google.com", "209.85.220.69")).toBe(
      false
    );
    expect(isGenericPtr("o4.ptr2793.mailservice.example", "167.89.64.97")).toBe(
      false
    );
  });

  it("parses Team Cymru origin and AS name answers", () => {
    expect(
      parseCymruOrigin("23028 23029 | 216.90.108.0/24 | us | ARIN | 1998-09-25")
    ).toEqual({
      asn: 23_028,
      prefix: "216.90.108.0/24",
      country: "US",
      registry: "arin",
    });
    expect(parseCymruOrigin("NA | | | |")).toBeNull();
    expect(
      parseCymruAsName("11377 | US | arin | 2001-08-13 | SENDGRID, US")
    ).toBe("SENDGRID");
    expect(
      parseCymruAsName(
        "15169 | US | arin | 2000-03-30 | GOOGLE - Google LLC, US"
      )
    ).toBe("Google LLC");
  });

  it("forward-confirms the PTR name and reads the AS", async () => {
    const intel = await lookupIpIntel(fakeResolver(senderTable), "8.8.4.4");
    expect(intel).toEqual({
      ptr: {
        status: "ok",
        names: ["mail-out.sender.example"],
        confirmed: "mail-out.sender.example",
        fcrdns: true,
        generic: false,
      },
      network: {
        status: "ok",
        asn: 15_169,
        asName: "Google LLC",
        prefix: "8.8.4.0/24",
        country: "US",
        registry: "arin",
      },
    });
  });

  it("reports a PTR that does not resolve back", async () => {
    const intel = await lookupIpIntel(
      fakeResolver({
        "PTR 4.4.8.8.in-addr.arpa": ["spoofed.example"],
        "A spoofed.example": ["192.0.2.1"],
      }),
      "8.8.4.4"
    );

    expect(intel.ptr).toMatchObject({
      names: ["spoofed.example"],
      confirmed: null,
      fcrdns: false,
    });
    expect(intel.network.status).toBe("nxdomain");
  });
});

describe("collectSenderIntel", () => {
  it("collects, caches per IP and matches HELO", async () => {
    const cache = memoryCache();
    const resolver = fakeResolver(senderTable);

    const input = {
      authentication: authentication({ dmarc: null }),
      fromAddress: "news@sender.example",
      linkDomains: [],
      workspaceDomains: ["demo.example"],
      dqsKey: null,
      bucket: unusedBucket,
      resolver,
      cache,
      now: 1000,
    };

    const first = await collectSenderIntel(input);
    expect(first).toMatchObject({
      ip: "8.8.4.4",
      ipVersion: 4,
      heloMatchesPtr: true,
      ptr: { fcrdns: true },
      network: { asn: 15_169 },
      spamhaus: null,
      bimi: null,
    });
    expect(cache.store.has("8.8.4.4")).toBe(true);
    const queries = resolver.queries.length;
    await collectSenderIntel(input);
    expect(resolver.queries.length).toBe(queries);
  });

  it("skips non-public addresses without any lookup", async () => {
    const resolver = fakeResolver({});

    const intel = await collectSenderIntel({
      authentication: authentication({ remoteIp: "203.0.113.5", dmarc: null }),
      fromAddress: "a@sender.example",
      linkDomains: [],
      workspaceDomains: [],
      dqsKey: null,
      bucket: unusedBucket,
      resolver,
      cache: memoryCache(),
    });

    expect(resolver.queries).toEqual([]);
    expect(intel.ptr.status).toBe("skipped");
    expect(intel.network.status).toBe("skipped");
  });

  it("fails open with a timeout status when DNS hangs past the budget", async () => {
    const started = Date.now();

    const intel = await collectSenderIntel({
      authentication: authentication({ dmarc: null }),
      fromAddress: "a@sender.example",
      linkDomains: ["links.example"],
      workspaceDomains: [],
      dqsKey: KEY,
      bucket: unusedBucket,
      resolver: fakeResolver({
        "PTR 4.4.8.8.in-addr.arpa": "hang",
        [`A 4.4.8.8.${KEY}.zen.dq.spamhaus.net`]: "hang",
      }),
      cache: memoryCache(),
      budgetMs: 50,
    });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(intel.ptr.status).toBe("timeout");
    expect(intel.spamhaus?.zen.status).toBe("timeout");
  });

  it("checks Spamhaus ZEN and DBL with the DQS key", async () => {
    const intel = await collectSenderIntel({
      authentication: authentication({ dmarc: null }),
      fromAddress: "a@sender.example",
      linkDomains: ["bad-links.example", "demo.example"],
      workspaceDomains: ["demo.example"],
      dqsKey: KEY,
      bucket: unusedBucket,
      resolver: fakeResolver({
        ...senderTable,
        [`A 4.4.8.8.${KEY}.zen.dq.spamhaus.net`]: ["127.0.0.10"],
        [`A bad-links.example.${KEY}.dbl.dq.spamhaus.net`]: ["127.0.1.4"],
      }),
      cache: memoryCache(),
    });

    expect(intel.spamhaus).toEqual({
      zen: {
        status: "ok",
        error: null,
        listings: [
          {
            zone: "zen",
            target: "8.8.4.4",
            code: "127.0.0.10",
            list: "PBL (ISP end-user range)",
            severity: "policy",
          },
        ],
      },
      dbl: {
        status: "ok",
        error: null,
        domains: ["sender.example", "bad-links.example"],
        listings: [
          {
            zone: "dbl",
            target: "bad-links.example",
            code: "127.0.1.4",
            list: "DBL phishing domain",
            severity: "abuse",
          },
        ],
      },
    });
  });
});

describe("Spamhaus", () => {
  it("treats 127.255.255.x as an error, never as a listing", async () => {
    expect(spamhausErrorCode("127.255.255.254")).toMatch(/public resolver/u);
    expect(spamhausErrorCode("127.0.0.2")).toBeNull();

    const result = await checkSpamhaus({
      resolve: fakeResolver({
        [`A 2.0.0.127.${KEY}.zen.dq.spamhaus.net`]: ["127.255.255.254"],
        [`A x.example.${KEY}.dbl.dq.spamhaus.net`]: ["127.255.255.255"],
      }),
      key: KEY,
      ip: "127.0.0.2",
      domains: ["x.example"],
    });

    expect(result.zen).toMatchObject({ status: "error", listings: [] });
    expect(result.dbl).toMatchObject({
      status: "error",
      listings: [],
      error: "Query limit exceeded for this key",
    });
  });
});

describe("link domains", () => {
  it("extracts registrable link domains in order, deduplicated and capped", () => {
    const html = `
      <a href="https://click.mail.shop.example/track?u=1&amp;v=2">Shop</a>
      <a href='http://www.shop.example/a'>again</a>
      <a href="mailto:x@y.example">mail</a>
      <a href="https://192.0.2.1/login">ip</a>
      <a href=https://unquoted.example/x>u</a>
      <img src="https://images.cdn.example/pixel.gif">
      <a href="https://portal.demo.example/">ours</a>`;

    expect(
      linkDomains({
        html,
        text: ["Visit https://text-only.example/path)."],
        workspaceDomains: ["demo.example"],
      })
    ).toEqual(["shop.example", "unquoted.example", "text-only.example"]);

    const many = Array.from(
      { length: 20 },
      (_, index) => `https://d${index}.example/`
    ).join(" ");

    expect(linkDomains({ text: [many] })).toHaveLength(10);
  });
});

describe("BIMI", () => {
  const logo =
    '<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 64 64"><title>Logo</title><defs><linearGradient id="g"/></defs><rect width="64" height="64" fill="url(#g)"/></svg>';

  it("parses records", () => {
    expect(
      parseBimiRecord("v=BIMI1; l=https://a.example/logo.svg; a=;")
    ).toEqual({ location: "https://a.example/logo.svg" });
    expect(parseBimiRecord("v=BIMI1; l=;")).toEqual({ location: null });
    expect(parseBimiRecord("v=spf1 -all")).toBeNull();
  });

  it("accepts SVG Tiny PS logos and rejects active or external content", () => {
    expect(validateBimiSvg(`<?xml version="1.0"?>\n${logo}`)).toHaveProperty(
      "svg"
    );

    const reject = (svg: string) =>
      expect(validateBimiSvg(svg)).toHaveProperty("error");

    reject(logo.replace("<title>", "<script>alert(1)</script><title>"));
    reject(
      logo.replace("<title>", "<foreignObject><div/></foreignObject><title>")
    );
    reject(logo.replace("<rect", '<rect onload="x()"'));
    reject(
      logo.replace(
        "<rect",
        '<image href="https://tracker.example/p.png"/><rect'
      )
    );
    reject(logo.replace("url(#g)", "url(https://x.example/a.svg#g)"));
    reject(
      logo.replace(
        "<rect",
        '<use xlink:href="https://x.example/a.svg#b"/><rect'
      )
    );
    reject(`<!DOCTYPE svg [<!ENTITY a "b">]>${logo}`);
    reject("<html><body>not svg</body></html>");
    reject(
      logo.replace(
        "<title>Logo</title>",
        `<title>${"x".repeat(33 * 1024)}</title>`
      )
    );
  });
});

it("renders country flags from ISO codes", () => {
  expect(countryFlag("US")).toBe("🇺🇸");
  expect(countryFlag("u1")).toBeNull();
});
