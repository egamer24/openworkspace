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

const OUTLOOK_HEADER = /^from:\s+.+$/iu;
const OUTLOOK_FOLLOWUP = /^(?:sent|date|to|subject):\s+.+$/iu;

/** Whether `text` starts a quote: an attribution line, or an Outlook header block (with the lines after it). */
function isAttribution(text: string, following: string[]) {
  const line = text.trim();

  if (ATTRIBUTION_LINE.some((pattern) => pattern.test(line))) return true;

  if (!OUTLOOK_HEADER.test(line)) return false;

  return following
    .slice(0, 4)
    .some((candidate) => OUTLOOK_FOLLOWUP.test(candidate.trim()));
}

function quotedBlockStart(lines: string[]) {
  for (const [index, text] of lines.entries()) {
    if (isAttribution(text, lines.slice(index + 1))) return index;
  }

  for (const [index, text] of lines.entries()) {
    if (!/^\s*>/u.test(text)) continue;
    const remaining = lines.slice(index).filter((line) => line.trim());
    const quoted = remaining.filter((line) => /^\s*>/u.test(line)).length;

    if (remaining.length && quoted / remaining.length >= 0.6) return index;
  }

  return -1;
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
