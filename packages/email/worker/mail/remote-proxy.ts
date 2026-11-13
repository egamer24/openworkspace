import { required } from "@open-workspace/core/shared";

import { repeatUntil } from "./repeat";

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal"];

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
]);

export const PROXYABLE_REMOTE_MEDIA_TYPES = new Set([
  "image/apng",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

export const MAX_REMOTE_PROXY_BYTES = 5 * 1024 * 1024;
export const REMOTE_PROXY_TIMEOUT_MS = 12_000;
export const REMOTE_PROXY_MAX_REDIRECTS = 3;

/** An IPv4 address as a 32-bit number, or null. The URL parser has already turned 0x7f.1 and 2130706433 into dotted form. */
function ipv4Number(hostname: string) {
  const parts = hostname.split(".");

  if (
    parts.length !== 4 ||
    !parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
  ) {
    return null;
  }

  return parts.reduce((value, part) => value * 256 + Number(part), 0);
}

/** IPv4 networks a proxied fetch must never reach: private, loopback, link-local, shared, reserved, multicast. */
const BLOCKED_IPV4: [network: string, bits: number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const BLOCKED_IPV4_RANGES = BLOCKED_IPV4.map(([network, bits]) => ({
  start: required(ipv4Number(network), `${network} is not an IPv4 address`),
  size: 2 ** (32 - bits),
}));

function isBlockedIpv4(address: number) {
  return BLOCKED_IPV4_RANGES.some(
    ({ start, size }) => address >= start && address < start + size
  );
}

type Ipv6Groups = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** The eight 16-bit groups of an IPv6 address (brackets, a zone, an IPv4 tail allowed), or null. */
function ipv6Groups(hostname: string): Ipv6Groups | null {
  let value = hostname
    .toLowerCase()
    .replaceAll(/^\[|\]$/gu, "")
    .split("%")[0];

  const tail = /:(\d+\.\d+\.\d+\.\d+)$/u.exec(value);

  if (tail) {
    const v4 = ipv4Number(tail[1]);

    if (v4 === null) return null;
    value = `${value.slice(0, tail.index)}:${(v4 >>> 16).toString(16)}:${(v4 & 0xff_ff).toString(16)}`;
  }

  const halves = value.split("::");

  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;

  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;

  const groups = [
    ...head,
    ...Array.from({ length: missing }, () => "0"),
    ...rest,
  ];

  if (!groups.every((group) => /^[0-9a-f]{1,4}$/u.test(group))) return null;

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups.map((group) =>
    Number.parseInt(group, 16)
  );

  if (groups.length !== 8) return null;

  return [g0, g1, g2, g3, g4, g5, g6, g7];
}

/**
 * Whether an IPv6 address is anything but a global unicast address on the
 * public internet: loopback, unspecified, IPv4-mapped or -compatible
 * (::ffff:7f00:1 is 127.0.0.1), NAT64 or 6to4 around a blocked IPv4
 * address, unique local, link- and site-local, documentation, discard,
 * Teredo, or multicast.
 */
function isBlockedIpv6(groups: Ipv6Groups) {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;

  const embedded = (high: number, low: number) =>
    isBlockedIpv4(high * 65_536 + low);

  if (groups.slice(0, 6).every((group) => group === 0)) return true; // ::, ::1, ::a.b.c.d

  if (groups.slice(0, 5).every((group) => group === 0) && g5 === 0xff_ff) {
    return true;
  } // ::ffff:a.b.c.d

  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0xff_ff &&
    g5 === 0
  ) {
    return true;
  } // ::ffff:0:a.b.c.d

  if (g0 === 0x64 && g1 === 0xff_9b) return g2 === 1 || embedded(g6, g7); // NAT64

  if (g0 === 0x20_02) return embedded(g1, g2); // 6to4

  if (g0 === 0x20_01 && g1 === 0) return true; // Teredo

  if (g0 === 0x20_01 && g1 === 0xd_b8) return true; // documentation

  if (g0 === 0x1_00 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard

  if ((g0 & 0xfe_00) === 0xfc_00) return true; // unique local

  if ((g0 & 0xff_c0) === 0xfe_80 || (g0 & 0xff_c0) === 0xfe_c0) return true; // link- and site-local

  if ((g0 & 0xff_00) === 0xff_00) return true; // multicast

  return false;
}

/** Whether a URL's (already normalized) host is an IP address the proxy must not reach. */
function isBlockedIp(hostname: string) {
  const v4 = ipv4Number(hostname);

  if (v4 !== null) return isBlockedIpv4(v4);

  if (!hostname.includes(":")) return false;
  const groups = ipv6Groups(hostname);

  // Anything that looks like IPv6 but does not parse is refused too.
  return !groups || isBlockedIpv6(groups);
}

export function assertProxyableRemoteUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Remote URL is invalid");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) remote URLs are allowed");
  }

  if (url.username || url.password) {
    throw new Error("Remote URLs must not include credentials");
  }

  // The URL parser has normalized the host: IPv4 in dotted decimal, IPv6
  // compressed in brackets. A trailing dot names the same host.
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");

  if (!host || BLOCKED_HOSTS.has(host)) {
    throw new Error("Remote host is not allowed");
  }

  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new Error("Remote host is not allowed");
  }

  if (isBlockedIp(host)) {
    throw new Error("Remote host is not allowed");
  }

  return url;
}

export function mediaType(contentType: string | null) {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function isProxyableRemoteMediaType(contentType: string | null) {
  const type = mediaType(contentType);

  if (PROXYABLE_REMOTE_MEDIA_TYPES.has(type)) return true;

  // Some CDNs send image/jpg; normalize already in set. image/x-png etc. rejected.
  return false;
}

export async function fetchProxiedRemoteMedia(remoteUrl: string) {
  let current = assertProxyableRemoteUrl(remoteUrl);

  // The first request and each redirect hop, one after another.
  const media = await repeatUntil(REMOTE_PROXY_MAX_REDIRECTS + 1, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_PROXY_TIMEOUT_MS);
    let response: Response;

    try {
      response = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          "user-agent": "OpenWorkspaceMailProxy/1.0",
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");

      if (!location) throw new Error("Remote redirect is missing a location");
      current = assertProxyableRemoteUrl(new URL(location, current).toString());

      return undefined;
    }

    if (!response.ok) {
      throw new Error(`Remote fetch failed (${response.status})`);
    }

    if (!isProxyableRemoteMediaType(response.headers.get("content-type"))) {
      throw new Error("Remote content type is not an allowed image");
    }

    const lengthHeader = response.headers.get("content-length");

    if (lengthHeader && Number(lengthHeader) > MAX_REMOTE_PROXY_BYTES) {
      throw new Error("Remote content is too large");
    }

    const buffer = await response.arrayBuffer();

    if (buffer.byteLength > MAX_REMOTE_PROXY_BYTES) {
      throw new Error("Remote content is too large");
    }

    return {
      body: buffer,
      contentType: mediaType(response.headers.get("content-type")),
    };
  });

  if (!media) throw new Error("Too many remote redirects");

  return media;
}
