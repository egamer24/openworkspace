import {
  headerFields,
  parseMailDate,
  splitTopLevel,
  trailingMailDate,
} from "./mail-headers";

/** The `by` host Cloudflare Email Routing writes on the hop it adds. */
export const CLOUDFLARE_RECEIVED_BY = "cloudflare-email.net";

export type ReceivedHop = {
  /** HELO name the sending server announced. */
  from: string | null;
  /** Reverse DNS name the receiving server resolved, when it differs. */
  reverseDns: string | null;
  /** Connecting IP, taken from the `from` clause only. */
  ip: string | null;
  by: string | null;
  protocol: string | null;
  tls: string | null;
  id: string | null;
  at: Date | null;
  /** Time since the nearest earlier hop with a parsed date. */
  delayMs: number | null;
  /** Negative clock difference absorbed into a zero delay. */
  skewMs: number | null;
  /**
   * The hop Cloudflare added at the top of the message. Every other hop was
   * written by the sending side and is only a claim.
   */
  trusted: boolean;
};

type Clause = {
  words: string[];
  comments: string[];
  /** Number of words seen before the first comment of the clause. */
  wordsBeforeComment: number | null;
};

const CLAUSE_KEYWORDS = new Set(["from", "by", "via", "with", "id", "for"]);

type RouteScanState = {
  current: Clause | null;
  token: string;
  comment: string;
  depth: number;
};

/** Tokenizes the route part into keyword clauses at comment depth 0. */
function routeClauses(route: string) {
  const clauses = new Map<string, Clause>();

  const state: RouteScanState = {
    current: null,
    token: "",
    comment: "",
    depth: 0,
  };

  const flushToken = () => {
    if (!state.token) return;
    const keyword = state.token.toLocaleLowerCase();

    if (CLAUSE_KEYWORDS.has(keyword) && !clauses.has(keyword)) {
      state.current = { words: [], comments: [], wordsBeforeComment: null };
      clauses.set(keyword, state.current);
    } else {
      state.current?.words.push(state.token);
    }

    state.token = "";
  };

  for (let index = 0; index < route.length; index += 1) {
    const char = route.charAt(index);

    if (char === "\\" && state.depth > 0) {
      state.comment += route.slice(index, index + 2);
      index += 1;
      continue;
    }

    if (char === "(") {
      if (state.depth === 0) flushToken();
      else state.comment += char;
      state.depth += 1;
      continue;
    }

    if (char === ")" && state.depth > 0) {
      state.depth -= 1;

      if (state.depth === 0) {
        const clause = state.current;

        if (clause) {
          clause.comments.push(state.comment.trim());
          clause.wordsBeforeComment ??= clause.words.length;
        }

        state.comment = "";
      } else {
        state.comment += char;
      }

      continue;
    }

    if (state.depth > 0) {
      state.comment += char;
      continue;
    }

    if (/\s/u.test(char)) flushToken();
    else state.token += char;
  }

  flushToken();

  return clauses;
}

// --- IP addresses ---------------------------------------------------------

function ipv4Octets(value: string): [number, number, number, number] | null {
  const parts = value.split(".");

  if (
    parts.length !== 4 ||
    !parts.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  ) {
    return null;
  }

  const [a, b, c, d] = parts.map(Number);

  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined
  ) {
    return null;
  }

  return [a, b, c, d];
}

function ipv4(value: string) {
  return ipv4Octets(value)?.join(".") ?? null;
}

function ipv6(value: string) {
  let text = value
    .toLocaleLowerCase()
    .replace(/^ipv6:/u, "")
    .replace(/%.*$/u, "");

  let tail: number[] = [];
  const v4 = /:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(text);

  if (v4) {
    const embedded = ipv4Octets(v4[1]);

    if (!embedded) return null;

    const [a, b, c, d] = embedded;

    tail = [(a << 8) | b, (c << 8) | d];
    text = `${text.slice(0, v4.index)}:`;

    if (text.endsWith("::")) text = text.slice(0, -1);
    else text = text.slice(0, -1);
  }

  const halves = text.split("::");

  if (halves.length > 2) return null;

  const parse = (part: string) =>
    part
      ? part
          .split(":")
          .map((group) =>
            /^[0-9a-f]{1,4}$/u.test(group)
              ? Number.parseInt(group, 16)
              : Number.NaN
          )
      : [];

  const [first = "", second] = halves;
  const head = parse(first);
  const rest = second === undefined ? [] : parse(second);
  const total = 8 - tail.length;

  if ([...head, ...rest].some(Number.isNaN)) return null;
  let groups: number[];

  if (halves.length === 2) {
    const missing = total - head.length - rest.length;

    if (missing < 1) return null;
    groups = [...head, ...Array.from({ length: missing }, () => 0), ...rest];
  } else {
    if (head.length !== total) return null;
    groups = head;
  }

  groups = [...groups, ...tail];
  // RFC 5952: compress the longest run (length >= 2) of zero groups.
  let bestStart = -1;
  let bestLength = 0;

  for (let start = 0; start < 8;) {
    if (groups[start] !== 0) {
      start += 1;
      continue;
    }

    let end = start;

    while (end < 8 && groups[end] === 0) end += 1;

    if (end - start > bestLength && end - start >= 2) {
      bestStart = start;
      bestLength = end - start;
    }

    start = end;
  }

  const hex = groups.map((group) => group.toString(16));

  if (bestStart < 0) return hex.join(":");

  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`;
}

/** Validates an IPv4 or IPv6 literal and returns its canonical form. */
export function normalizeIp(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim().replaceAll(/^\[|\]$/gu, "");

  return trimmed.includes(":") ? ipv6(trimmed) : ipv4(trimmed);
}

function fromClauseIp(clause: Clause) {
  const parts = [clause.words.join(" "), ...clause.comments];

  for (const part of parts) {
    for (const match of part.matchAll(/\[(?:IPv6:)?([0-9a-f:.]+)\]/giu)) {
      const ip = normalizeIp(match[1]);

      if (ip) return { ip, part, literal: match[0] };
    }
  }

  // Bare literals in parentheses: Cloudflare "(192.0.2.1)", Microsoft "(2603:…::12)".
  for (const comment of clause.comments) {
    const ip = normalizeIp(comment);

    if (ip) return { ip, part: comment, literal: comment };
  }

  return null;
}

function heloName(clause: Clause) {
  for (const comment of clause.comments) {
    const helo = /\bhelo[= ]\s*([^\s)\]]+)/iu.exec(comment)?.[1];

    if (helo) return helo;
  }

  const value = clause.words[0];

  return value && !/^\[.*\]$/u.test(value) ? value : null;
}

function reverseDnsName(found: { part: string; literal: string } | null) {
  if (!found || found.part === found.literal) return null;

  const before = found.part
    .slice(0, found.part.indexOf(found.literal))
    .trim()
    .split(/\s+/u)
    .at(-1);

  if (!before) return null;
  const name = before.replace(/\.$/u, "");

  if (
    name.toLocaleLowerCase() === "unknown" ||
    !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/iu.test(name)
  ) {
    return null;
  }

  return name;
}

function tlsDetails(value: string) {
  const version =
    /\bversion=(TLS1_[0-3])\b/u.exec(value)?.[1]?.replace("_", ".") ??
    /\busing (TLSv1\.[0-3])\b/u.exec(value)?.[1] ??
    /\((TLS1\.[0-3])\)/u.exec(value)?.[1];

  if (version) return version.replace(/^TLSv?/u, "TLS ");

  if (/\bwith\s+(?:E?SMTPS|ESMTPSA|UTF8SMTPS)\b/iu.test(value)) return "TLS";

  if (/\(Google Transport Security\)/u.test(value)) return "TLS";

  if (/\bcipher[= ]/iu.test(value)) return "TLS";

  return null;
}

type ParsedHop = Omit<ReceivedHop, "delayMs" | "skewMs" | "trusted">;

export function parseReceived(value: string): ParsedHop {
  const segments = splitTopLevel(value, ";");
  let route: string;
  let at: Date | null = null;

  if (segments.length > 1) {
    route = segments.slice(0, -1).join(";");
    at = parseMailDate(segments.at(-1));
  } else {
    // SendGrid and some HTTP submission hops omit the `;` before the date.
    const trailing = trailingMailDate(value);
    at = trailing?.date ?? null;
    route = trailing ? value.slice(0, trailing.index) : value;
  }

  const clauses = routeClauses(route);
  const fromClause = clauses.get("from");
  const found = fromClause ? fromClauseIp(fromClause) : null;
  const from = fromClause ? heloName(fromClause) : null;
  const reverseDns = reverseDnsName(found);
  const withClause = clauses.get("with");

  return {
    from,
    reverseDns:
      reverseDns && reverseDns.toLocaleLowerCase() !== from?.toLocaleLowerCase()
        ? reverseDns
        : null,
    ip: found?.ip ?? null,
    by: clauses.get("by")?.words[0] ?? null,
    protocol: withClause?.words.length
      ? withClause.words
          .slice(
            0,
            Math.min(
              withClause.wordsBeforeComment ?? withClause.words.length,
              4
            )
          )
          .join(" ") || null
      : null,
    tls: tlsDetails(value),
    id: clauses.get("id")?.words[0] ?? null,
    at,
  };
}

export function isCloudflareHop(hop: Pick<ParsedHop, "by">) {
  return hop.by?.toLocaleLowerCase() === CLOUDFLARE_RECEIVED_BY;
}

const MAX_SKEW_MS = 10 * 60_000;

/** Received headers in delivery order: the sender's first relay first. */
export function receivedHops(raw: string): ReceivedHop[] {
  const values = headerFields(raw).flatMap((field) =>
    field.name === "received" ? [field.value] : []
  );

  const parsed = values.map(parseReceived);

  const hops = parsed
    .map((hop, index) => ({
      ...hop,
      trusted: index === 0 && isCloudflareHop(hop),
    }))
    .reverse();

  let previous: Date | null = null;

  return hops.map((hop) => {
    let delayMs: number | null = null;
    let skewMs: number | null = null;

    if (hop.at && previous) {
      const delta = hop.at.getTime() - previous.getTime();

      if (delta >= 0) delayMs = delta;
      else if (-delta < MAX_SKEW_MS) {
        delayMs = 0;
        skewMs = delta;
      }
    }

    // A skewed hop keeps the later reference so the next delay is not inflated.
    if (hop.at && (!previous || (delayMs !== null && skewMs === null))) {
      previous = hop.at;
    }

    return { ...hop, delayMs, skewMs };
  });
}

export type IpKind = "public" | "private" | "loopback" | "reserved";

/** Rough classification; enough to tell an internal hop from the internet. */
export function ipKind(ip: string): IpKind {
  const lower = ip.toLowerCase();

  if (lower === "::1" || lower.startsWith("127.")) return "loopback";

  if (
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd][0-9a-f]{2}:|fe80:)/u.test(
      lower
    )
  ) {
    return "private";
  }

  // Documentation, shared and link-local ranges never appear on the open internet.
  if (
    /^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.|2001:db8:)/u.test(
      lower
    )
  ) {
    return "reserved";
  }

  return "public";
}
