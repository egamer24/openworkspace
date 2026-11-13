import { organizationalDomain } from "./org-domain";

export const ONE_CLICK_TIMEOUT_MS = 10_000;
const USER_AGENT = "OpenWorkspace-Unsubscribe/1.0";

export type OneClickFetcher = (request: Request) => Promise<Response>;

export type OneClickResult =
  | { ok: true; status: number; redirected: boolean }
  | { ok: false; status: number | null; detail: string };

/** A List-Id compared without angle brackets or case. */
function normalizeListId(value: string | null | undefined) {
  return (
    (value ?? "")
      .trim()
      .toLocaleLowerCase()
      .replace(/^.*<([^>]*)>.*$/u, "$1")
      .trim() || null
  );
}

/** One unsubscribe record per list: its List-Id, else the sender's organizational domain. */
export function unsubscribeListKey(input: {
  listId: string | null;
  fromAddress: string | null;
}) {
  const listId = normalizeListId(input.listId);

  if (listId) return `list:${listId}`;
  const domain = organizationalDomain(input.fromAddress);

  return domain ? `domain:${domain}` : null;
}

function isOneClickUrl(value: string) {
  try {
    const url = new URL(value);

    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * RFC 8058 one-click: a single POST with the fixed form body. No cookies or
 * credentials, no redirects followed, never a GET, bounded by a timeout.
 * A 3xx violates the RFC but usually means the request was processed.
 */
export async function postOneClick(
  url: string,
  fetcher: OneClickFetcher = (request) => fetch(request),
  timeoutMs = ONE_CLICK_TIMEOUT_MS
): Promise<OneClickResult> {
  if (!isOneClickUrl(url)) {
    return {
      ok: false,
      status: null,
      detail: "The unsubscribe address is not HTTPS",
    };
  }

  const request = new Request(url, {
    method: "POST",
    body: "List-Unsubscribe=One-Click",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });

  try {
    const response = await fetcher(request);
    // Nothing in the body is used; release it promptly.
    await response.body?.cancel().catch(() => undefined);

    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status, redirected: false };
    }

    if (response.status >= 300 && response.status < 400) {
      return { ok: true, status: response.status, redirected: true };
    }

    return {
      ok: false,
      status: response.status,
      detail: `The sender's server answered ${response.status}`,
    };
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");

    return {
      ok: false,
      status: null,
      detail: timedOut
        ? "The sender's server did not answer in time"
        : "Could not reach the sender's server",
    };
  }
}

export type MailtoUnsubscribe = { to: string; subject: string; body: string };

/**
 * Recipient, subject and body of a `mailto:` unsubscribe URI. Other header
 * fields (cc, bcc, …) are ignored so the request reaches only the list.
 */
export function parseMailtoUnsubscribe(uri: string): MailtoUnsubscribe | null {
  let url: URL;

  try {
    url = new URL(uri);
  } catch {
    return null;
  }

  if (url.protocol !== "mailto:") return null;
  let to: string;

  try {
    to = decodeURIComponent(url.pathname).trim();
  } catch {
    return null;
  }

  if (!/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/u.test(to) || to.length > 254) {
    return null;
  }

  // RFC 6068 percent-encodes everything; "+" is a literal plus, not a space.
  const pairs = url.search
    .slice(1)
    .split("&")
    .flatMap((pair) => {
      const [key = "", value = ""] = pair.split("=", 2);

      try {
        return [
          [
            decodeURIComponent(key).toLocaleLowerCase(),
            decodeURIComponent(value),
          ] as const,
        ];
      } catch {
        return [];
      }
    });

  const field = (name: string) =>
    pairs
      .find(([key]) => key === name)?.[1]
      .replaceAll(/[\r\n]+/gu, " ")
      .trim() ?? "";

  return {
    to,
    subject: field("subject").slice(0, 200) || "unsubscribe",
    body: field("body").slice(0, 2000) || "unsubscribe",
  };
}

export function oneClickHost(url: string | null) {
  if (!url) return null;

  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
