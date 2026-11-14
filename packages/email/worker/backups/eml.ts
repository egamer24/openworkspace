import type { MailAddress } from "../mailbox/model";

/**
 * A small RFC 5322 / MIME writer for mail that has no stored raw MIME:
 * outgoing mail goes to Email Sending as structured fields. The same input
 * always gives the same bytes, so backup objects deduplicate by hash.
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
  attachments: {
    filename: string;
    type: string;
    disposition: "attachment" | "inline";
    contentId?: string;
    content: ArrayBuffer;
  }[];
};

const CRLF = "\r\n";
const encoder = new TextEncoder();
const ASCII = /^[ -~]*$/u;

/** One line: CR and LF never reach a header from stored values. */
function headerSafe(value: string) {
  return value.replaceAll(/[\r\n]+/gu, " ");
}

function base64(bytes: Uint8Array) {
  let binary = "";

  for (let index = 0; index < bytes.length; index += 0x80_00) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x80_00));
  }

  return btoa(binary);
}

/** RFC 2047 encoded words, split on code points to stay under 75 characters. */
export function encodeHeaderWord(value: string) {
  const clean = headerSafe(value);

  if (ASCII.test(clean)) return clean;
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
    .map((word) => `=?UTF-8?B?${base64(encoder.encode(word))}?=`)
    .join(`${CRLF} `);
}

function formatAddress({ address, name }: MailAddress) {
  if (!name) return headerSafe(address);

  const display = ASCII.test(name)
    ? `"${headerSafe(name).replaceAll(/["\\]/gu, String.raw`\$&`)}"`
    : encodeHeaderWord(name);

  return `${display} <${headerSafe(address)}>`;
}

function base64Lines(bytes: Uint8Array) {
  return base64(bytes).replaceAll(/.{1,76}/gu, `$&${CRLF}`);
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

function attachmentPart(attachment: EmlInput["attachments"][number]) {
  const filename = encodeHeaderWord(attachment.filename).replaceAll('"', "'");

  const lines = [
    `Content-Type: ${headerSafe(attachment.type)}; name="${filename}"`,
    `Content-Disposition: ${attachment.disposition}; filename="${filename}"`,
  ];

  if (attachment.contentId) {
    const id = headerSafe(attachment.contentId).replaceAll(/^<|>$/gu, "");
    lines.push(`Content-ID: <${id}>`);
  }

  lines.push(
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(new Uint8Array(attachment.content))
  );

  return lines.join(CRLF);
}

export function serializeEml(input: EmlInput): Uint8Array<ArrayBuffer> {
  const bodies: string[] = [];

  if (input.text !== undefined) bodies.push(textPart("text/plain", input.text));

  if (input.html !== undefined) bodies.push(textPart("text/html", input.html));

  let body =
    bodies.length === 2
      ? multipart("alternative", `ow-alt-${input.id}`, bodies)
      : (bodies[0] ?? textPart("text/plain", ""));

  if (input.attachments.length) {
    body = multipart("mixed", `ow-mixed-${input.id}`, [
      body,
      ...input.attachments.map(attachmentPart),
    ]);
  }

  const headers: string[] = [];

  const addresses = (name: string, list: MailAddress[]) => {
    if (list.length) {
      headers.push(`${name}: ${list.map(formatAddress).join(", ")}`);
    }
  };

  addresses("From", input.from);
  addresses("To", input.to);
  addresses("Cc", input.cc);
  addresses("Bcc", input.bcc);
  addresses("Reply-To", input.replyTo);
  headers.push(
    `Subject: ${encodeHeaderWord(input.subject)}`,
    `Date: ${input.date.toUTCString().replace("GMT", "+0000")}`
  );

  if (input.messageId) {
    headers.push(`Message-ID: ${headerSafe(input.messageId)}`);
  }

  if (input.inReplyTo.length) {
    headers.push(`In-Reply-To: ${headerSafe(input.inReplyTo.join(" "))}`);
  }

  if (input.references.length) {
    headers.push(`References: ${headerSafe(input.references.join(" "))}`);
  }

  headers.push("MIME-Version: 1.0");

  return encoder.encode(`${headers.join(CRLF)}${CRLF}${body}`);
}
