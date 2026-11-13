import type {
  SpamhausCheck,
  SpamhausListing,
  SpamhausResult,
} from "../../shared/mail-sender-intel";
import type { DnsAnswer, DnsResolver } from "./doh";
import { reversedIp } from "./ip-intel";

/**
 * Spamhaus Data Query Service: the customer key is part of the zone name, so
 * the lists answer through any resolver, including DoH. Public-resolver
 * queries against the legacy zones only return 127.255.255.254.
 * https://docs.spamhaus.com/datasets/docs/source/40-real-world-usage/PublicMirrors/MTAs/020-Postfix.html
 */

export const DQS_KEY_PATTERN = /^[a-z0-9]{20,40}$/u;

const zenCodes = new Map(
  Object.entries({
    "127.0.0.2": { list: "SBL (spam source)", severity: "abuse" },
    "127.0.0.3": { list: "SBL CSS (snowshoe spam)", severity: "abuse" },
    "127.0.0.4": { list: "XBL (compromised host)", severity: "abuse" },
    "127.0.0.5": { list: "XBL (compromised host)", severity: "abuse" },
    "127.0.0.6": { list: "XBL (compromised host)", severity: "abuse" },
    "127.0.0.7": { list: "XBL (compromised host)", severity: "abuse" },
    "127.0.0.9": { list: "DROP (hijacked network)", severity: "abuse" },
    "127.0.0.10": { list: "PBL (ISP end-user range)", severity: "policy" },
    "127.0.0.11": { list: "PBL (end-user range)", severity: "policy" },
  } satisfies Record<string, Pick<SpamhausListing, "list" | "severity">>)
);

const dblCodes = new Map(
  Object.entries({
    "127.0.1.2": "spam domain",
    "127.0.1.4": "phishing domain",
    "127.0.1.5": "malware domain",
    "127.0.1.6": "botnet C&C domain",
    "127.0.1.102": "abused legitimate domain (spam)",
    "127.0.1.103": "abused redirector or shortener",
    "127.0.1.104": "abused legitimate domain (phishing)",
    "127.0.1.105": "abused legitimate domain (malware)",
    "127.0.1.106": "abused legitimate domain (botnet C&C)",
  })
);

const errorCodes = new Map(
  Object.entries({
    "127.255.255.252": "The query was malformed",
    "127.255.255.254": "Queried through a public resolver without a DQS key",
    "127.255.255.255": "Query limit exceeded for this key",
  })
);

/** 127.255.255.x is never a listing: it reports a problem with the query itself. */
export function spamhausErrorCode(code: string) {
  return code.startsWith("127.255.255.")
    ? (errorCodes.get(code) ?? "Spamhaus returned an error code")
    : null;
}

function interpret(
  zone: "zen" | "dbl",
  target: string,
  answer: DnsAnswer
): Omit<SpamhausCheck, "status"> & { status: SpamhausCheck["status"] } {
  if (answer.status === "nxdomain") {
    return { status: "ok", listings: [], error: null };
  }

  if (answer.status !== "ok") {
    return { status: answer.status, listings: [], error: null };
  }

  const error = answer.records.map(spamhausErrorCode).find(Boolean) ?? null;

  if (error) return { status: "error", listings: [], error };

  const listings = answer.records.flatMap((code): SpamhausListing[] => {
    if (zone === "zen") {
      const known = zenCodes.get(code);

      return known ? [{ zone, target, code, ...known }] : [];
    }

    const list = dblCodes.get(code);

    return list
      ? [{ zone, target, code, list: `DBL ${list}`, severity: "abuse" }]
      : [];
  });

  return { status: "ok", listings, error: null };
}

function merge(checks: SpamhausCheck[]): SpamhausCheck {
  const failed = checks.find((check) => check.status !== "ok");

  return {
    status:
      checks.length === 0
        ? "skipped"
        : failed && checks.every((check) => check.status !== "ok")
          ? failed.status
          : "ok",
    listings: checks.flatMap((check) => check.listings),
    error: checks.map((check) => check.error).find(Boolean) ?? null,
  };
}

export async function checkSpamhaus(input: {
  resolve: DnsResolver;
  key: string;
  ip: string | null;
  domains: string[];
}): Promise<SpamhausResult> {
  const { ip } = input;

  const zen = ip
    ? input
        .resolve(`${reversedIp(ip)}.${input.key}.zen.dq.spamhaus.net`, "A")
        .then((answer) => interpret("zen", ip, answer))
    : Promise.resolve<SpamhausCheck>({
        status: "skipped",
        listings: [],
        error: null,
      });

  const dbl = Promise.all(
    input.domains.map(async (domain) =>
      interpret(
        "dbl",
        domain,
        await input.resolve(`${domain}.${input.key}.dbl.dq.spamhaus.net`, "A")
      )
    )
  );

  const [zenResult, dblResults] = await Promise.all([zen, dbl]);

  return {
    zen: zenResult,
    dbl: { ...merge(dblResults), domains: input.domains },
  };
}
