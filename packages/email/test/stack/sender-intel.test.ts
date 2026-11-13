import { describe, expect, it } from "bun:test";

import { internet } from "@open-workspace/core/testing";
import type { InboundAuthentication } from "@open-workspace/email/shared/mail-authentication.ts";
import type {
  BimiResult,
  SenderIntel,
} from "@open-workspace/email/shared/mail-sender-intel.ts";
import { bimiObjectKey } from "@open-workspace/email/worker/mail/bimi.ts";

import { env, hooks, useFreshWorkspace } from "./workspace.ts";

// The BIMI logo cache lives in the mail bucket; the rest of sender
// intelligence is tested without bindings in test/unit/sender-intel.test.ts.
useFreshWorkspace();

type BimiLookup = { result: BimiResult; queries: string[] };

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

describe("BIMI", () => {
  const logo =
    '<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 64 64"><title>Logo</title><defs><linearGradient id="g"/></defs><rect width="64" height="64" fill="url(#g)"/></svg>';

  it("fetches, validates and caches the logo per domain in R2", async () => {
    const domain = `brand-${crypto.randomUUID().slice(0, 8)}.example`;
    let downloads = 0;
    const urls: string[] = [];
    internet.handle((request) => {
      if (!request.target.hostname.endsWith(domain)) return undefined;
      downloads += 1;
      urls.push(request.url);

      return new Response(logo, {
        headers: { "content-type": "image/svg+xml" },
      });
    });

    const input = {
      table: {
        [`TXT default._bimi.${domain}`]: [
          `v=BIMI1; l=https://cdn.${domain}/bimi.svg`,
        ],
      },
      fromDomain: `mail.${domain}`,
      orgDomain: domain,
      now: 5000,
    };

    expect(
      (await hooks.call<BimiLookup>("mailbox.resolveBimi", input)).result
    ).toEqual({ domain, status: "ok", reason: null });
    expect(
      await (await env.MAIL_STORAGE.get(bimiObjectKey(domain)))?.text()
    ).toBe(logo);
    expect(
      (await hooks.call<BimiLookup>("mailbox.resolveBimi", input)).result
    ).toEqual({ domain, status: "ok", reason: null });
    expect(urls).toEqual([`https://cdn.${domain}/bimi.svg`]);
    expect(downloads).toBe(1);
  });

  it("refuses plain-HTTP logos and only runs after an enforcing DMARC pass", async () => {
    const domain = `plain-${crypto.randomUUID().slice(0, 8)}.example`;
    expect(
      (
        await hooks.call<BimiLookup>("mailbox.resolveBimi", {
          table: {
            [`TXT default._bimi.${domain}`]: [
              `v=BIMI1; l=http://${domain}/logo.svg`,
            ],
          },
          fetch: false,
          fromDomain: domain,
          orgDomain: domain,
        })
      ).result
    ).toMatchObject({ status: "invalid" });

    const { intel, queries } = await hooks.call<{
      intel: SenderIntel;
      queries: string[];
    }>("mailbox.collectSenderIntel", {
      table: {},
      authentication: authentication({
        remoteIp: null,
        dmarc: {
          result: "pass",
          headerFrom: "sender.example",
          policy: "none",
          alignedVia: ["spf"],
        },
      }),
      fromAddress: "a@sender.example",
      linkDomains: [],
      workspaceDomains: [],
      dqsKey: null,
    });

    expect(intel.bimi).toBeNull();
    expect(queries).toEqual([]);
  });
});
