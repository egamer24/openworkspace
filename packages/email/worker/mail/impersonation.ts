import { getDomainWithoutSuffix } from "tldts";

import { organizationalDomain } from "./org-domain";

// --- Punycode (RFC 3492 decoding only) ------------------------------------

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;

function adapt(delta: number, points: number, first: boolean) {
  let value = first ? Math.floor(delta / DAMP) : delta >> 1;
  value += Math.floor(value / points);
  let k = 0;

  while (value > ((BASE - T_MIN) * T_MAX) >> 1) {
    value = Math.floor(value / (BASE - T_MIN));
    k += BASE;
  }

  return k + Math.floor(((BASE - T_MIN + 1) * value) / (value + SKEW));
}

function digit(code: number) {
  if (code >= 48 && code <= 57) return code - 22;

  if (code >= 65 && code <= 90) return code - 65;

  if (code >= 97 && code <= 122) return code - 97;

  return BASE;
}

export function decodePunycodeLabel(input: string) {
  const delimiter = input.lastIndexOf("-");
  const basic = delimiter > 0 ? input.slice(0, delimiter) : "";

  // RFC 3492 §6.2: the part before the delimiter holds basic (ASCII) code points only.
  const output = Array.from(basic, (char) => char.charCodeAt(0));

  if (output.some((code) => code >= 0x80)) return null;

  let n = 128;
  let i = 0;
  let bias = 72;

  for (let index = delimiter > 0 ? delimiter + 1 : 0; index < input.length;) {
    const oldI = i;

    for (let w = 1, k = BASE; ; k += BASE) {
      if (index >= input.length) return null;
      const value = digit(input.charCodeAt(index++));

      if (value >= BASE) return null;
      i += value * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;

      if (value < t) break;
      w *= BASE - t;
    }

    bias = adapt(i - oldI, output.length + 1, oldI === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;

    if (n > 0x10_ff_ff) return null;
    output.splice(i++, 0, n);
  }

  return String.fromCodePoint(...output);
}

/** `xn--` labels decoded to Unicode; other labels unchanged. */
export function domainToUnicode(domain: string) {
  return domain
    .split(".")
    .map((label) =>
      label.toLocaleLowerCase().startsWith("xn--")
        ? (decodePunycodeLabel(label.slice(4)) ?? label)
        : label
    )
    .join(".");
}

// --- Confusable skeleton (a practical subset of UTS #39) ------------------

const CONFUSABLES = new Map(
  Object.entries({
    // Cyrillic
    а: "a",
    в: "b",
    е: "e",
    ё: "e",
    к: "k",
    м: "m",
    н: "h",
    о: "o",
    р: "p",
    с: "c",
    т: "t",
    у: "y",
    х: "x",
    ѕ: "s",
    і: "i",
    ї: "i",
    ј: "j",
    ԁ: "d",
    һ: "h",
    ӏ: "l",
    ԛ: "q",
    ԝ: "w",
    ɡ: "g",
    // Greek
    α: "a",
    β: "b",
    ε: "e",
    η: "n",
    ι: "i",
    κ: "k",
    ν: "v",
    ο: "o",
    ρ: "p",
    τ: "t",
    υ: "u",
    χ: "x",
    ω: "w",
    // Look-alike digits and symbols
    "0": "o",
    "1": "l",
    "3": "e",
    "5": "s",
    "|": "l",
    ı: "i",
    ł: "l",
    ø: "o",
    đ: "d",
  })
);

/** Lowercased, accent-free, confusables folded, with multi-letter look-alikes merged. */
export function confusableSkeleton(value: string) {
  const folded = [...value.normalize("NFKD").toLocaleLowerCase()]
    .flatMap((char) =>
      /\p{M}/u.test(char) ? [] : [CONFUSABLES.get(char) ?? char]
    )
    .join("");

  return folded
    .replaceAll("rn", "m")
    .replaceAll("vv", "w")
    .replaceAll("cl", "d")
    .replaceAll("i", "l");
}

export function levenshtein(left: string, right: string) {
  if (left === right) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];

    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
    }

    previous = current;
  }

  return previous[right.length];
}

/** Registrable label without the public suffix, e.g. `demo` for `mail.demo.example`. */
function registrableLabel(domain: string) {
  return getDomainWithoutSuffix(domain) ?? domain.split(".").at(-2) ?? domain;
}

function maxEdits(length: number) {
  if (length < 4) return 0;

  return length < 7 ? 1 : 2;
}

/**
 * The workspace domain that `senderDomain` imitates, if any. Compares the
 * registrable labels after Unicode/punycode confusable folding, and the
 * whole registrable name without separators (`demo-examp1e.com` vs `demo.example`).
 */
export function lookalikeOf(
  senderDomain: string | null,
  workspaceDomains: readonly string[]
) {
  if (!senderDomain) return null;
  const unicode = domainToUnicode(senderDomain.toLocaleLowerCase());
  const senderOrg = organizationalDomain(senderDomain) ?? senderDomain;

  const senderLabel = confusableSkeleton(
    registrableLabel(domainToUnicode(senderOrg))
  );

  const senderFlat = senderLabel.replaceAll(/[^\p{L}\p{N}]/gu, "");

  for (const workspace of workspaceDomains) {
    const own = workspace.toLocaleLowerCase();
    const ownOrg = organizationalDomain(own) ?? own;

    if (senderOrg === ownOrg) continue;
    const ownLabel = confusableSkeleton(registrableLabel(ownOrg));

    const ownFlat = confusableSkeleton(ownOrg).replaceAll(
      /[^\p{L}\p{N}]/gu,
      ""
    );

    if (ownLabel.length < 3) continue;

    // Same name under another suffix, or a homoglyph/punycode spelling of it.
    if (senderLabel === ownLabel || senderFlat === ownFlat) {
      return { domain: unicode, resembles: own };
    }

    if (levenshtein(senderLabel, ownLabel) <= maxEdits(ownLabel.length)) {
      return { domain: unicode, resembles: own };
    }

    if (
      ownFlat.length >= 6 &&
      levenshtein(senderFlat, ownFlat) <= maxEdits(ownFlat.length)
    ) {
      return { domain: unicode, resembles: own };
    }
  }

  return null;
}

// --- Display names ----------------------------------------------------------

export function normalizedPersonName(value: string | null | undefined) {
  if (!value) return "";

  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

/** Internal names worth protecting: at least two words, so "Support" alone never matches. */
export function protectedNames(names: (string | null | undefined)[]) {
  const result = new Map<string, string>();

  for (const name of names) {
    if (!name) continue;
    const normalized = normalizedPersonName(name);

    if (normalized.split(" ").length >= 2 && normalized.length >= 5) {
      result.set(normalized, name.trim().replaceAll(/\s+/gu, " "));
    }
  }

  return result;
}

/** The internal person an external From display name copies, if any. */
export function impersonatedName(
  displayName: string | null | undefined,
  names: ReadonlyMap<string, string>
) {
  const normalized = normalizedPersonName(displayName);

  if (!normalized) return null;

  return names.get(normalized) ?? null;
}

/** `"ceo@ourco.com" <x@elsewhere.example>`: an address in the name that is not the sender. */
export function embeddedAddress(
  displayName: string | null | undefined,
  fromAddress: string
) {
  const match = displayName?.match(
    /[^\s<>"'()@]+@[a-z0-9.-]+\.[a-z]{2,}/iu
  )?.[0];

  if (!match) return null;

  return match.toLocaleLowerCase() === fromAddress.toLocaleLowerCase()
    ? null
    : match;
}
