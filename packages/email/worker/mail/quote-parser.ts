export type ParsedReplyText = {
  bodyText: string;
  quotedText: string | null;
};

/**
 * Attribution lines are short; longer lines are never tested, which keeps a
 * crafted single-line body from costing more than a scan.
 */
const MAX_ATTRIBUTION_LENGTH = 300;

/** How many lines after an Outlook `From:` line may hold its other headers. */
const OUTLOOK_FOLLOWUP_LINES = 4;

const OUTLOOK_HEADER = /^from:\s+\S/iu;
const OUTLOOK_FOLLOWUP = /^(?:sent|date|to|subject):\s+\S/iu;
const QUOTED_LINE = /^\s*>/u;

/** Characters `.` does not match; an attribution line never contains one. */
const LINE_TERMINATOR = /[\r\u2028\u2029]/u;

/**
 * Whether `line` is `<prefix><at least one character><suffix>`, the shape of
 * `^prefix.+suffix$`, tested without a regular expression.
 */
function wraps(line: string, prefix: string, suffix: string) {
  return (
    line.length > prefix.length + suffix.length &&
    line.startsWith(prefix) &&
    line.endsWith(suffix)
  );
}

/** `Am <date> schrieb <name>:` (German). */
function isGermanAttribution(line: string) {
  if (!wraps(line, "am ", ":")) return false;
  const marker = line.indexOf("schrieb ", "am ".length + 1);

  // At least one character between the marker and the closing colon.
  return marker !== -1 && marker + "schrieb ".length < line.length - 1;
}

/** `Le <date>, <name> a écrit :` (French). */
function isFrenchAttribution(line: string) {
  if (!wraps(line, "le ", ":")) return false;

  return wraps(line.slice(0, -1).trimEnd(), "le ", "a écrit");
}

const SEPARATORS = [
  /^-----\s*original message\s*-----$/iu,
  /^-----\s*исходное сообщение\s*-----$/iu,
];

/** Whether a trimmed line is a quote's attribution line in one of the known languages. */
function isAttributionLine(line: string) {
  if (line.length > MAX_ATTRIBUTION_LENGTH || LINE_TERMINATOR.test(line)) {
    return false;
  }

  const lower = line.toLowerCase();

  return (
    wraps(lower, "on ", "wrote:") ||
    isGermanAttribution(lower) ||
    isFrenchAttribution(lower) ||
    wraps(lower, "в ", "написал:") ||
    wraps(lower, "в ", "написала:") ||
    SEPARATORS.some((pattern) => pattern.test(line))
  );
}

/** Whether line `index` starts a quote: an attribution line, or an Outlook header block (with the lines after it). */
function isAttribution(lines: string[], index: number) {
  const line = (lines[index] ?? "").trim();

  if (isAttributionLine(line)) return true;

  if (!OUTLOOK_HEADER.test(line)) return false;

  return lines
    .slice(index + 1, index + 1 + OUTLOOK_FOLLOWUP_LINES)
    .some((candidate) => OUTLOOK_FOLLOWUP.test(candidate.trim()));
}

/**
 * The first `>` line from which at least 60% of the non-blank lines are
 * quoted. One backward pass counts both for every suffix of the body.
 */
function trailingQuoteStart(lines: string[]) {
  let nonBlank = 0;
  let quoted = 0;
  let start = -1;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";

    if (line.trim()) nonBlank += 1;

    if (!QUOTED_LINE.test(line)) continue;
    quoted += 1;

    if (quoted / nonBlank >= 0.6) start = index;
  }

  return start;
}

function quotedBlockStart(lines: string[]) {
  for (const index of lines.keys()) {
    if (isAttribution(lines, index)) return index;
  }

  return trailingQuoteStart(lines);
}

export function parseReplyText(
  value: string | undefined | null
): ParsedReplyText {
  const normalized = (value ?? "").replaceAll("\r\n", "\n").trim();

  if (!normalized) return { bodyText: "", quotedText: null };
  const lines = normalized.split("\n");
  const splitAt = quotedBlockStart(lines);

  if (splitAt < 0) return { bodyText: normalized, quotedText: null };
  const bodyText = lines.slice(0, splitAt).join("\n").trim();
  const quotedText = lines.slice(splitAt).join("\n").trim();

  return { bodyText, quotedText: quotedText || null };
}
