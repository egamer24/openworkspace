/**
 * Low-level RFC 5322 header helpers shared by ingestion (worker) and the
 * "Show original" panel (browser). Everything here is pure and works on the
 * raw message text, so header order is preserved exactly as received.
 */

const MAX_HEADER_BYTES = 256 * 1024;

export type HeaderField = {
  /** Lowercased field name. */
  name: string;
  /** Unfolded value with surrounding whitespace removed. */
  value: string;
};

export function headerBlock(raw: string) {
  const separator = /\r?\n\r?\n/u.exec(raw);
  const end = separator?.index ?? raw.length;

  return raw.slice(0, Math.min(end, MAX_HEADER_BYTES));
}

/** Header fields of the top-level entity, in their original (topmost first) order. */
export function headerFields(raw: string): HeaderField[] {
  const unfolded = headerBlock(raw).replaceAll(/\r?\n[\t ]+/gu, " ");

  return unfolded.split(/\r?\n/gu).flatMap((line) => {
    const colon = line.indexOf(":");

    if (colon < 1) return [];
    const name = line.slice(0, colon).trim().toLocaleLowerCase();

    if (!/^[\u0021-\u0039\u003B-\u007E]+$/u.test(name)) return [];

    return [{ name, value: line.slice(colon + 1).trim() }];
  });
}

export function headerValues(raw: string, name: string) {
  const expected = name.toLocaleLowerCase();

  return headerFields(raw).flatMap((field) =>
    field.name === expected && field.value ? [field.value] : []
  );
}

export type CommentScan = {
  /** The value with every top-level comment replaced by a single space. */
  text: string;
  /** Text of each outermost comment, without its parentheses. */
  comments: string[];
};

/**
 * Removes RFC 5322 comments (which may nest and contain quoted pairs) while
 * leaving quoted strings intact.
 */
export function scanComments(value: string): CommentScan {
  let text = "";
  let comment = "";
  const comments: string[] = [];
  let depth = 0;
  let quoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);

    if (char === "\\" && (quoted || depth > 0) && index + 1 < value.length) {
      const pair = value.slice(index, index + 2);

      if (depth > 0) comment += pair;
      else text += pair;
      index += 1;
      continue;
    }

    if (depth === 0 && char === '"') quoted = !quoted;

    if (!quoted && char === "(") {
      if (depth > 0) comment += char;
      depth += 1;
      continue;
    }

    if (!quoted && char === ")" && depth > 0) {
      depth -= 1;

      if (depth === 0) {
        comments.push(comment.trim());
        comment = "";
        text += " ";
      } else {
        comment += char;
      }

      continue;
    }

    if (depth > 0) comment += char;
    else text += char;
  }

  if (depth > 0 && comment) comments.push(comment.trim());

  return { text, comments };
}

/**
 * Splits on a delimiter that appears outside comments and quoted strings.
 * Each part keeps its comments so callers can still read them.
 */
export function splitTopLevel(value: string, delimiter: string) {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);

    if (char === "\\" && (quoted || depth > 0) && index + 1 < value.length) {
      current += value.slice(index, index + 2);
      index += 1;
      continue;
    }

    if (depth === 0 && char === '"') quoted = !quoted;
    else if (!quoted && char === "(") depth += 1;
    else if (!quoted && char === ")" && depth > 0) depth -= 1;

    if (char === delimiter && depth === 0 && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  parts.push(current);

  return parts;
}

export function unquote(value: string) {
  const trimmed = value.trim();

  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll(/\\(.)/gu, "$1");
  }

  return trimmed;
}

/** Domain part of an address or a bare domain, lowercased without a trailing dot. */
export function addressDomain(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim().replaceAll(/^<|>$/gu, "");
  const at = trimmed.lastIndexOf("@");

  const domain = (at === -1 ? trimmed : trimmed.slice(at + 1))
    .replace(/\.$/u, "")
    .toLocaleLowerCase();

  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u.test(
    domain
  )
    ? domain
    : null;
}

// --- Dates ---------------------------------------------------------------

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/** RFC 5322 §4.3 obsolete zones; military zones are treated as unknown (-0000). */
const OBSOLETE_ZONES = new Map([
  ["ut", 0],
  ["gmt", 0],
  ["z", 0],
  ["utc", 0],
  ["est", -5 * 60],
  ["edt", -4 * 60],
  ["cst", -6 * 60],
  ["cdt", -5 * 60],
  ["mst", -7 * 60],
  ["mdt", -6 * 60],
  ["pst", -8 * 60],
  ["pdt", -7 * 60],
]);

export const RFC5322_DATE_PATTERN =
  /(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s*)?(\d{1,2})\s+([a-z]{3})[a-z]*\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*([+-]\d{4}|[a-z]{1,3}\b)?/iu;

export const ISO_DATE_PATTERN =
  /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*([+-]\d{2}:?\d{2}|Z)?/iu;

function zoneOffsetMinutes(zone: string | undefined) {
  if (!zone) return 0;
  const numeric = /^([+-])(\d{2}):?(\d{2})$/u.exec(zone);

  if (numeric) {
    const minutes = Number(numeric[2]) * 60 + Number(numeric[3]);

    return numeric[1] === "-" ? -minutes : minutes;
  }

  return OBSOLETE_ZONES.get(zone.toLocaleLowerCase()) ?? 0;
}

function utcDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  offsetMinutes: number
) {
  if (
    month < 0 ||
    month > 11 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 60
  ) {
    return null;
  }

  const time =
    Date.UTC(year, month, day, hour, minute, Math.min(second, 59)) -
    offsetMinutes * 60_000;

  return Number.isFinite(time) ? new Date(time) : null;
}

function rfc5322Match(match: RegExpMatchArray) {
  const [, day, monthName, yearText, hour, minute, second, zone] = match;

  if (monthName === undefined || yearText === undefined) return null;
  const month = MONTHS.indexOf(monthName.toLocaleLowerCase());
  let year = Number(yearText);

  // RFC 5322 §4.3: two-digit years are 19xx when >= 50, 20xx otherwise.
  if (yearText.length <= 2) year += year >= 50 ? 1900 : 2000;
  else if (yearText.length === 3) year += 1900;

  return utcDate(
    year,
    month,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? 0),
    zoneOffsetMinutes(zone)
  );
}

function isoMatch(match: RegExpMatchArray) {
  return utcDate(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    zoneOffsetMinutes(match[7])
  );
}

/**
 * Strict date parser for header dates. Accepts RFC 5322 dates (day name
 * optional, fractional seconds, obsolete zones) and ISO / Go timestamps such
 * as SendGrid's `2026-10-29 15:24:22.353912098 +0000 UTC m=+…`. Never falls
 * back to `new Date(string)`, whose non-ISO parsing is implementation-defined.
 */
export function parseMailDate(value: string | null | undefined) {
  if (!value) return null;
  const text = scanComments(value).text.trim();
  const rfc = RFC5322_DATE_PATTERN.exec(text);

  if (rfc && rfc.index <= 12) return rfc5322Match(rfc);
  const iso = ISO_DATE_PATTERN.exec(text);

  if (iso && iso.index <= 12) return isoMatch(iso);

  return null;
}

/** Finds a date at the end of a header that has no `;` before it. */
export function trailingMailDate(value: string) {
  const rfc = new RegExp(RFC5322_DATE_PATTERN.source, "giu");
  const iso = new RegExp(ISO_DATE_PATTERN.source, "giu");
  let best: { index: number; date: Date } | null = null;

  for (const [pattern, parse] of [
    [rfc, rfc5322Match],
    [iso, isoMatch],
  ] as const) {
    for (const match of value.matchAll(pattern)) {
      const date = parse(match);

      if (date && (!best || match.index > best.index)) {
        best = { index: match.index, date };
      }
    }
  }

  return best;
}
