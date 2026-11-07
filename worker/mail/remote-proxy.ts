const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal"];
const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
]);

const PRIVATE_IPV4 =
  /^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/u;

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

function isIpv4(hostname: string) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(hostname);
}

function isIpv6(hostname: string) {
  return hostname.includes(":");
}

function isBlockedIp(hostname: string) {
  if (isIpv4(hostname)) {
    return PRIVATE_IPV4.test(hostname) || hostname === "255.255.255.255";
  }
  if (isIpv6(hostname)) {
    // URL parsing serializes IPv6 (and any embedded IPv4) as hex groups, so a
    // prefix check on dotted text never matches. Allow only global unicast
    // (2000::/3) that cannot embed an IPv4 address (6to4 2002::/16, Teredo 2001::/32).
    const groups = hostname.toLowerCase().replace(/^\[|\]$/gu, "").split(":");
    const first = Number.parseInt(groups[0] || "0", 16);
    const second = Number.parseInt(groups[1] || "0", 16);
    return !(first >= 0x2000 && first <= 0x3fff) || first === 0x2002 || (first === 0x2001 && second === 0);
  }
  return false;
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
  // "localhost." is the same host as "localhost".
  const host = url.hostname.toLowerCase().replace(/\.+$/u, "");
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
  for (let hop = 0; hop <= REMOTE_PROXY_MAX_REDIRECTS; hop += 1) {
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
      continue;
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
  }
  throw new Error("Too many remote redirects");
}
