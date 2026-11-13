/**
 * A streaming mbox reader: messages one at a time, however large the file.
 * Messages start at a "From " line at the start of the file or after an
 * empty line; the empty line before it belongs to no message. Body lines
 * escaped as ">From " (mboxrd's ">+From ") lose one ">".
 */

export type MboxMessage = {
  /** The message's bytes, or empty when it was larger than `maxBytes`. */
  raw: Uint8Array<ArrayBuffer>;
  /** The separator line ("From sender date"), without the line break. */
  fromLine: string;
  /** Position in the file, from 0. */
  index: number;
  /** The message's size in bytes (counted even when it was too large to keep). */
  size: number;
  tooLarge: boolean;
};

const FROM = [70, 114, 111, 109, 32]; // "From "
const decoder = new TextDecoder("latin1");

function startsWithFrom(line: Uint8Array, offset = 0) {
  for (let index = 0; index < FROM.length; index += 1) {
    if (line[offset + index] !== FROM[index]) return false;
  }

  return true;
}

function isBlank(line: Uint8Array) {
  return (
    (line.length === 1 && line[0] === 10) ||
    (line.length === 2 && line[0] === 13 && line[1] === 10)
  );
}

function concat(parts: Uint8Array[], size: number) {
  const out = new Uint8Array(size);
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }

  return out;
}

export async function* readMbox(
  stream: AsyncIterable<Uint8Array>,
  options: { maxBytes: number }
): AsyncGenerator<MboxMessage> {
  let pending: Uint8Array = new Uint8Array(0);
  let lines: Uint8Array[] = [];
  let size = 0;
  let fromLine: string | null = null;
  let index = 0;
  let tooLarge = false;
  let previousBlank = true;
  const ready: MboxMessage[] = [];

  const finishMessage = () => {
    if (fromLine === null) return;
    // The empty line before the next "From " separates; it is not the message's.
    const last = lines.at(-1);

    if (last && isBlank(last)) {
      lines.pop();
      size -= last.byteLength;
    }

    ready.push({
      raw: tooLarge ? new Uint8Array(0) : concat(lines, size),
      fromLine,
      index,
      size,
      tooLarge,
    });
    index += 1;
    lines = [];
    size = 0;
    tooLarge = false;
  };

  const line = (bytes: Uint8Array) => {
    if (previousBlank && startsWithFrom(bytes)) {
      finishMessage();
      fromLine = decoder.decode(bytes).replace(/\r?\n$/u, "");
      previousBlank = false;

      return;
    }

    previousBlank = isBlank(bytes);

    if (fromLine === null) return;
    let content = bytes;

    if (content[0] === 62) {
      let quotes = 0;

      while (content[quotes] === 62) quotes += 1;

      if (startsWithFrom(content, quotes)) content = content.subarray(1);
    }

    size += content.byteLength;

    if (tooLarge) return;

    if (size > options.maxBytes) {
      tooLarge = true;
      // An empty line may end the message; keep only that much.
      lines = isBlank(content) ? [content] : [];

      return;
    }

    lines.push(content);
  };

  for await (const chunk of stream) {
    const data = pending.byteLength
      ? concat([pending, chunk], pending.byteLength + chunk.byteLength)
      : chunk;

    let start = 0;

    for (
      let newline = data.indexOf(10, start);
      newline !== -1;
      newline = data.indexOf(10, start)
    ) {
      line(data.subarray(start, newline + 1));
      start = newline + 1;
    }

    pending = data.slice(start);
    yield* ready.splice(0);
  }

  if (pending.byteLength) line(pending);
  finishMessage();
  yield* ready.splice(0);
}

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

/**
 * The date on an mbox "From " line, in ms: Gmail's Takeout writes when the
 * message arrived there ("From 1781…@xxx Tue Mar 03 10:00:00 +0000 2026").
 * Classic ctime dates without a zone are read as UTC.
 */
export function fromLineDate(fromLine: string) {
  const match =
    /\s(?:[A-Za-z]{3}),?\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s+([+-]\d{4}))?\s+(\d{4})\s*$/u.exec(
      fromLine
    );

  if (!match) return undefined;
  const [, monthName = ""] = match;
  const month = MONTHS.indexOf(monthName.toLowerCase());

  if (month === -1) return undefined;

  const utc = Date.UTC(
    Number(match[7]),
    month,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5])
  );

  const zone = match[6];

  const offset = zone
    ? (zone[0] === "-" ? -1 : 1) *
      (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5))) *
      60_000
    : 0;

  return utc - offset;
}
