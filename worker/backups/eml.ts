import type { MailAddress } from "../mailbox/model";

/**
 * Minimal RFC 5322 / MIME serializer for messages that have no stored raw
 * MIME (outgoing mail is handed to Email Service as structured fields). Output
 * is deterministic for the same input so backup objects deduplicate by hash.
 */
export type EmlInput = {
  id: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo: MailAddress[];
  subject: string;
  date: Date;
  messageId: string | null;
  inReplyTo: string[];
  references: string[];
  text?: string;
  html?: string;
  attachments: Array<{
    filename: string;
    contentType: string;
    disposition: "attachment" | "inline";
    contentId: string | null;
    content: Uint8Array;
  }>;
};

const CRLF = "\r\n";
const encoder = new TextEncoder();

function headerSafe(value: string) {
  return value.replace(/[\r\n]+/gu, " ");
}

/** RFC 2047 encoded words, split on code points to stay under ~75 chars. */
export function encodeHeaderWord(value: string) {
  const clean = headerSafe(value);
  if (/^[\x20-\x7e]*$/u.test(clean)) return clean;
  const words: string[] = [];
  let chunk = "";
  for (const character of clean) {
    if (encoder.encode(chunk + character).byteLength > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) words.push(chunk);
  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`)
    .join(`${CRLF} `);
}

function formatAddress({ address, name }: MailAddress) {
  if (!name) return headerSafe(address);
  const display = /^[\x20-\x7e]*$/u.test(name)
    ? `"${headerSafe(name).replace(/["\\]/gu, "\\$&")}"`
    : encodeHeaderWord(name);
  return `${display} <${headerSafe(address)}>`;
}

function base64Lines(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64").replace(/.{1,76}/gu, `$&${CRLF}`);
}

function textPart(contentType: string, value: string) {
  return [
    `Content-Type: ${contentType}; charset=utf-8`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(encoder.encode(value)),
  ].join(CRLF);
}

function multipart(subtype: string, boundary: string, parts: string[]) {
  return [
    `Content-Type: multipart/${subtype}; boundary="${boundary}"`,
    "",
    ...parts.map((part) => `--${boundary}${CRLF}${part}`),
    `--${boundary}--`,
    "",
  ].join(CRLF);
}

export function serializeEml(input: EmlInput): Uint8Array<ArrayBuffer> {
  const bodies = [
    ...(input.text !== undefined ? [textPart("text/plain", input.text)] : []),
    ...(input.html !== undefined ? [textPart("text/html", input.html)] : []),
  ];
  let body = bodies.length === 2
    ? multipart("alternative", `ow-alt-${input.id}`, bodies)
    : bodies[0] ?? textPart("text/plain", "");
  if (input.attachments.length) {
    body = multipart("mixed", `ow-mixed-${input.id}`, [
      body,
      ...input.attachments.map((attachment) => {
        const filename = encodeHeaderWord(attachment.filename).replace(/"/gu, "'");
        return [
          `Content-Type: ${headerSafe(attachment.contentType)}; name="${filename}"`,
          `Content-Disposition: ${attachment.disposition}; filename="${filename}"`,
          ...(attachment.contentId
            ? [`Content-ID: <${headerSafe(attachment.contentId).replace(/^<|>$/gu, "")}>`]
            : []),
          "Content-Transfer-Encoding: base64",
          "",
          base64Lines(attachment.content),
        ].join(CRLF);
      }),
    ]);
  }

  const addressHeader = (name: string, addresses: MailAddress[]) =>
    addresses.length ? [`${name}: ${addresses.map(formatAddress).join(", ")}`] : [];
  const headers = [
    ...addressHeader("From", input.from),
    ...addressHeader("To", input.to),
    ...addressHeader("Cc", input.cc),
    ...addressHeader("Bcc", input.bcc),
    ...addressHeader("Reply-To", input.replyTo),
    `Subject: ${encodeHeaderWord(input.subject)}`,
    `Date: ${input.date.toUTCString().replace("GMT", "+0000")}`,
    ...(input.messageId ? [`Message-ID: ${headerSafe(input.messageId)}`] : []),
    ...(input.inReplyTo.length ? [`In-Reply-To: ${headerSafe(input.inReplyTo.join(" "))}`] : []),
    ...(input.references.length ? [`References: ${headerSafe(input.references.join(" "))}`] : []),
    "MIME-Version: 1.0",
  ];
  return encoder.encode(`${headers.join(CRLF)}${CRLF}${body}`);
}
