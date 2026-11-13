/**
 * Same-origin proxy path used inside sanitized HTML iframes; `token` is the
 * one the conversation response's `remoteTokens` gives for `remoteUrl`.
 */
export function mailRemoteProxyPath(
  mailboxId: string,
  token: string,
  remoteUrl: string
) {
  const params = new URLSearchParams({
    mailboxId,
    token,
    url: remoteUrl,
  });

  return `/api/mail/remote?${params.toString()}`;
}

export function isRemoteHttpUrl(value: string) {
  try {
    const url = new URL(value);

    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** More remote images than any real message holds; the rest are not proxied. */
export const MAX_REMOTE_IMAGES_PER_MESSAGE = 300;

const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["quot", '"'],
  ["apos", "'"],
  ["lt", "<"],
  ["gt", ">"],
]);

function decodeEntities(value: string) {
  return value.replaceAll(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu,
    (match, decimal, hex, name) => {
      if (decimal) return String.fromCodePoint(Number(decimal));

      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));

      return NAMED_ENTITIES.get(name.toLowerCase()) ?? match;
    }
  );
}

/**
 * Every http(s) URL in a message's HTML that the browser could find as an
 * image source (src, srcset, background, CSS url()), as the browser reads
 * it: entities decoded. A generous superset; the server signs a proxy token
 * for each, and the browser proxies only URLs it has a token for.
 */
export function remoteImageUrls(html: string) {
  const found = new Set<string>();

  for (const [match] of html.matchAll(/https?:\/\/[^\s"'<>()`]+/giu)) {
    for (const raw of [match, decodeEntities(match)]) {
      // A srcset or a sentence can run a comma or period into the URL.
      for (const url of [raw, raw.replace(/[,.;]+$/u, "")]) {
        if (isRemoteHttpUrl(url)) found.add(url);
      }
    }

    if (found.size >= MAX_REMOTE_IMAGES_PER_MESSAGE) break;
  }

  return [...found].slice(0, MAX_REMOTE_IMAGES_PER_MESSAGE);
}
