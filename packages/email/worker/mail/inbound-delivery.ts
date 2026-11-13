import {
  bytesToBase64Url,
  normalizeEmail,
  normalizeMailboxAddress,
} from "@open-workspace/core/module";

export async function inboundDeliveryId(input: {
  mailboxId: string;
  envelopeFrom: string;
  envelopeTo: string;
  raw: ArrayBuffer;
}) {
  const prefix = new TextEncoder().encode(
    [
      input.mailboxId,
      normalizeEmail(input.envelopeFrom),
      normalizeMailboxAddress(input.envelopeTo),
      "",
    ].join("\0")
  );

  const rawDigest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", input.raw)
  );

  const digestInput = new Uint8Array(prefix.byteLength + rawDigest.byteLength);
  digestInput.set(prefix);
  digestInput.set(rawDigest, prefix.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", digestInput);

  return `in_${bytesToBase64Url(new Uint8Array(digest))}`;
}
