import { normalizeIp } from "../../shared/mail-received";
import type { SenderIntel } from "../../shared/mail-sender-intel";
import type { DnsResolver } from "./doh";
import { organizationalDomain } from "./org-domain";

const MAX_CONFIRMED_PTR_NAMES = 2;

export type IpIntel = Pick<SenderIntel, "ptr" | "network">;

function expandIpv6(ip: string) {
  const [head = "", tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = ip.includes("::") ? (tail ? tail.split(":") : []) : [];

  const fill = Array.from(
    { length: 8 - left.length - right.length },
    () => "0"
  );

  return [...left, ...fill, ...right]
    .map((group) => group.padStart(4, "0"))
    .join("");
}

/** `1.2.3.4` → `4.3.2.1`; IPv6 → nibble-reversed hex, as used under in-addr.arpa / ip6.arpa. */
export function reversedIp(ip: string) {
  if (ip.includes(":")) return [...expandIpv6(ip)].reverse().join(".");

  return ip.split(".").reverse().join(".");
}

export function reverseDnsName(ip: string) {
  return `${reversedIp(ip)}.${ip.includes(":") ? "ip6.arpa" : "in-addr.arpa"}`;
}

const GENERIC_PTR_WORDS =
  /(?:^|[.-])(?:dynamic|dyn|pool|dsl|adsl|xdsl|vdsl|dhcp|dialup|dial|ppp|pppoe|cable|broadband|customer|cust|clients|residential|cpe|fttx|ftth)(?:\d*[.-]|$)/u;

/** Auto-generated access-network names such as `1-2-3-4.dsl.example.net`. */
export function isGenericPtr(name: string, ip: string) {
  const host = name.toLocaleLowerCase();

  if (!ip.includes(":")) {
    const octets = ip.split(".");
    const forward = octets.join("[.-]");
    const backward = [...octets].reverse().join("[.-]");

    if (
      new RegExp(`(?:^|\\D)(?:${forward}|${backward})(?:\\D|$)`, "u").test(host)
    ) {
      return true;
    }

    const hex = octets
      .map((octet) => Number(octet).toString(16).padStart(2, "0"))
      .join("");

    if (host.includes(hex)) return true;
  }

  const firstLabels = host.split(".").slice(0, -2).join(".");

  return GENERIC_PTR_WORDS.test(firstLabels);
}

/** `"15169 | 8.8.8.0/24 | US | arin | 1992-12-01"` (first ASN wins for multi-origin prefixes). */
export function parseCymruOrigin(value: string) {
  const [asns, prefix, country, registry] = value
    .split("|")
    .map((part) => part.trim());

  const asn = Number(asns?.split(/\s+/u)[0]);

  if (!Number.isInteger(asn) || asn <= 0) return null;

  return {
    asn,
    prefix: prefix || null,
    country:
      country && /^[a-z]{2}$/iu.test(country) ? country.toUpperCase() : null,
    registry: registry?.toLocaleLowerCase() || null,
  };
}

/** `"15169 | US | arin | 2000-03-30 | GOOGLE - Google LLC, US"` → `Google LLC`. */
export function parseCymruAsName(value: string) {
  const raw = value.split("|").slice(4).join("|").trim();

  if (!raw) return null;
  const withoutCountry = raw.replace(/,\s*[A-Z]{2}$/u, "").trim();
  const dash = withoutCountry.indexOf(" - ");

  const name =
    dash === -1 ? withoutCountry : withoutCountry.slice(dash + 3).trim();

  return name.slice(0, 120) || null;
}

async function ptrIntel(
  resolve: DnsResolver,
  ip: string
): Promise<IpIntel["ptr"]> {
  const answer = await resolve(reverseDnsName(ip), "PTR");
  const names = [...new Set(answer.records)].filter(Boolean).slice(0, 5);
  const [firstName] = names;

  if (answer.status !== "ok" || firstName === undefined) {
    return {
      status: answer.status === "ok" ? "nxdomain" : answer.status,
      names: [],
      confirmed: null,
      fcrdns:
        answer.status === "ok" || answer.status === "nxdomain" ? false : null,
      generic: null,
    };
  }

  const forwardType = ip.includes(":") ? "AAAA" : "A";

  const checks = await Promise.all(
    names.slice(0, MAX_CONFIRMED_PTR_NAMES).map(async (name) => {
      const forward = await resolve(name, forwardType);

      const confirmed = forward.records.some(
        (record) => normalizeIp(record) === ip
      );

      return { name, status: forward.status, confirmed };
    })
  );

  const confirmed = checks.find((check) => check.confirmed)?.name ?? null;

  const answered = checks.some(
    (check) => check.status === "ok" || check.status === "nxdomain"
  );

  return {
    status: "ok",
    names,
    confirmed,
    fcrdns: confirmed ? true : answered ? false : null,
    generic: isGenericPtr(confirmed ?? firstName, ip),
  };
}

async function networkIntel(
  resolve: DnsResolver,
  ip: string
): Promise<IpIntel["network"]> {
  const empty = {
    asn: null,
    asName: null,
    prefix: null,
    country: null,
    registry: null,
  };

  const zone = ip.includes(":")
    ? "origin6.asn.cymru.com"
    : "origin.asn.cymru.com";

  const origin = await resolve(`${reversedIp(ip)}.${zone}`, "TXT");
  const parsed = origin.records.map(parseCymruOrigin).find(Boolean) ?? null;

  if (!parsed) {
    return {
      status: origin.status === "ok" ? "nxdomain" : origin.status,
      ...empty,
    };
  }

  const name = await resolve(`AS${parsed.asn}.asn.cymru.com`, "TXT");

  return {
    status: "ok",
    ...parsed,
    asName: name.records.map(parseCymruAsName).find(Boolean) ?? null,
  };
}

/** PTR → forward confirmation and Team Cymru origin → AS name, in parallel. */
export async function lookupIpIntel(
  resolve: DnsResolver,
  ip: string
): Promise<IpIntel> {
  const [ptr, network] = await Promise.all([
    ptrIntel(resolve, ip),
    networkIntel(resolve, ip),
  ]);

  return { ptr, network };
}

export function heloMatchesPtr(helo: string | null, ptr: IpIntel["ptr"]) {
  if (!helo || !ptr.names.length) return null;
  const name = helo.toLocaleLowerCase().replace(/\.$/u, "");
  const org = organizationalDomain(name);

  return ptr.names.some(
    (candidate) =>
      candidate === name ||
      (org !== null && organizationalDomain(candidate) === org)
  );
}

/** Per-IP results are cacheable; timeouts and errors are not. */
export function ipIntelCacheTtl(intel: IpIntel) {
  const failed = (status: string) => status === "timeout" || status === "error";

  if (failed(intel.ptr.status) || failed(intel.network.status)) return 0;

  if (intel.ptr.status === "nxdomain" || intel.network.status === "nxdomain") {
    return 3600;
  }

  return 86_400;
}
