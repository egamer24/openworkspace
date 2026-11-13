/** Reading the top-level headers of a raw RFC 5322 message, as much as an importer needs. */

const MAX_HEADER_BYTES = 256 * 1024;
const latin1 = new TextDecoder("latin1");

/** The header section of a raw message (bytes up to the first empty line), as text. */
export function headerText(raw: Uint8Array) {
  const limit = Math.min(raw.byteLength, MAX_HEADER_BYTES);

  for (let index = 0; index < limit; index += 1) {
    if (raw[index] !== 10) continue;

    if (raw[index + 1] === 10) return decodeHeader(raw.subarray(0, index));

    if (raw[index + 1] === 13 && raw[index + 2] === 10) {
      return decodeHeader(raw.subarray(0, index));
    }
  }

  return decodeHeader(raw.subarray(0, limit));
}

/** UTF-8 where it is valid (raw UTF-8 headers are common), Latin-1 otherwise. */
function decodeHeader(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return latin1.decode(bytes);
  }
}

export type HeaderFields = Map<string, string[]>;

/** Unfolded header fields by lowercased name, in order. */
export function parseHeaders(text: string): HeaderFields {
  const fields: HeaderFields = new Map();

  for (const line of text.replaceAll(/\r?\n[\t ]+/gu, " ").split(/\r?\n/u)) {
    const colon = line.indexOf(":");

    if (colon < 1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    fields.set(name, [...(fields.get(name) ?? []), value]);
  }

  return fields;
}

export function header(fields: HeaderFields, name: string) {
  return fields.get(name)?.[0];
}

/** Decodes RFC 2047 encoded words (`=?UTF-8?Q?...?=`), as Gmail writes non-ASCII label names. */
export function decodeWords(value: string) {
  return value
    .replaceAll(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?)/gu, "$1")
    .replaceAll(
      /[=]\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/gu,
      (word, charset: string, encoding: string, text: string) => {
        try {
          const bytes =
            encoding.toUpperCase() === "B"
              ? Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
              : Uint8Array.from(
                  text
                    .replaceAll("_", " ")
                    .replaceAll(/[=]([0-9A-Fa-f]{2})/gu, (_, hex: string) =>
                      String.fromCharCode(Number.parseInt(hex, 16))
                    ),
                  (char) => char.charCodeAt(0)
                );

          // RFC 2231 puts a language after "*": "utf-8*en".
          const [label = ""] = charset.split("*");

          // SAFETY: Bun types the label as its list of known encodings; the constructor checks it at runtime and throws a RangeError for any other, which the catch below turns into the undecoded word.
          return new TextDecoder(label.toLowerCase() as Bun.Encoding).decode(
            bytes
          );
        } catch {
          return word;
        }
      }
    );
}

/** The message ids in a Message-ID, In-Reply-To or References value, in order. */
export function messageIds(value: string | undefined) {
  return [...(value ?? "").matchAll(/<([^<>\s]+)>/gu)].map(([, id]) => id);
}

/**
 * A thread key for mail without a source thread id: the first message of
 * the thread its References name (else the one it replies to, else itself).
 * Unlike threading by parent, it does not depend on import order.
 */
export function rootThreadKey(fields: HeaderFields) {
  const root =
    messageIds(header(fields, "references"))[0] ??
    messageIds(header(fields, "in-reply-to"))[0] ??
    messageIds(header(fields, "message-id"))[0];

  return root ? `mid:${root.toLowerCase()}` : undefined;
}
