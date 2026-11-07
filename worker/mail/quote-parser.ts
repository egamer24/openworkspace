export type ParsedReplyText = {
  bodyText: string;
  quotedText: string | null;
};

const ATTRIBUTION_LINE = [
  /^on .+wrote:\s*$/iu,
  /^am .+schrieb .+:\s*$/iu,
  /^le .+a écrit\s*:\s*$/iu,
  /^в .+написал(?:а)?:\s*$/iu,
  /^-----\s*original message\s*-----$/iu,
  /^-----\s*исходное сообщение\s*-----$/iu,
];

// Linear on purpose: these run on every line of a sender's text.
const OUTLOOK_HEADER = /^from:[ \t]+\S/iu;
const OUTLOOK_FOLLOWUP = /^(?:sent|date|to|subject):[ \t]+\S/iu;
/** Attribution lines are short; longer ones would make `.+….+` backtrack. */
const MAX_ATTRIBUTION_LENGTH = 300;

function isAttribution(lines: string[], index: number) {
  const line = lines[index]!.trim();
  if (line.length > MAX_ATTRIBUTION_LENGTH) return false;
  if (ATTRIBUTION_LINE.some((pattern) => pattern.test(line))) return true;
  if (!OUTLOOK_HEADER.test(line)) return false;
  return lines
    .slice(index + 1, index + 5)
    .some((candidate) => OUTLOOK_FOLLOWUP.test(candidate.trim()));
}

function quotedBlockStart(lines: string[]) {
  for (let index = 0; index < lines.length; index += 1) {
    if (isAttribution(lines, index)) return index;
  }
  // Suffix counts in one backward pass (re-filtering the rest per line was quadratic).
  const isQuoted = lines.map((line) => /^\s*>/u.test(line));
  const nonEmpty = new Array<number>(lines.length + 1).fill(0);
  const quoted = new Array<number>(lines.length + 1).fill(0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const filled = lines[index]!.trim() !== "";
    nonEmpty[index] = nonEmpty[index + 1]! + Number(filled);
    quoted[index] = quoted[index + 1]! + Number(filled && isQuoted[index]!);
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (isQuoted[index] && quoted[index]! / nonEmpty[index]! >= 0.6) return index;
  }
  return -1;
}

export function parseReplyText(value: string | undefined | null): ParsedReplyText {
  const normalized = (value ?? "").replaceAll("\r\n", "\n").trim();
  if (!normalized) return { bodyText: "", quotedText: null };
  const lines = normalized.split("\n");
  const splitAt = quotedBlockStart(lines);
  if (splitAt < 0) return { bodyText: normalized, quotedText: null };
  const bodyText = lines.slice(0, splitAt).join("\n").trim();
  const quotedText = lines.slice(splitAt).join("\n").trim();
  return { bodyText, quotedText: quotedText || null };
}

