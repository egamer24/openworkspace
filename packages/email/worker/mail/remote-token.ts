import {
  base64UrlToBytes,
  bytesToBase64Url,
} from "@open-workspace/core/module";

/**
 * Capability tokens for the remote image proxy (GET /api/mail/remote). The
 * conversation response hands the browser one for each remote image URL in
 * a message's HTML (`remoteTokens`), and the sanitized message HTML puts it
 * in that image's proxied URL, so the proxy checks a signature instead of a
 * session and mailbox access in D1, and fetches only URLs a message holds.
 *
 * A token is `<userId>.<expiry>.<HMAC-SHA256>` over the user, the mailbox,
 * the image URL and the expiry. Expiries fall on the end of the window after the current one:
 * every token issued within a window is the same (cached documents and the
 * browser's image cache keep their URLs), and a token is valid for between
 * one and two windows. Losing access to a mailbox, or signing out, stops its
 * images loading at the latest when the token expires.
 */
export const REMOTE_TOKEN_WINDOW_MS = 6 * 60 * 60 * 1000;

const keys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string) {
  let key = keys.get(secret);

  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );
    keys.set(secret, key);
  }

  return key;
}

function signedText(
  userId: string,
  mailboxId: string,
  url: string,
  expiresAt: number
) {
  return new TextEncoder().encode(
    `mail-remote\n${userId}\n${mailboxId}\n${expiresAt}\n${url}`
  );
}

/** The token `userId` uses for the remote image at `url` in `mailboxId`'s mail, at `now`. */
export async function signRemoteToken(
  secret: string,
  userId: string,
  mailboxId: string,
  url: string,
  now = Date.now()
) {
  const expiresAt =
    (Math.floor(now / REMOTE_TOKEN_WINDOW_MS) + 2) * REMOTE_TOKEN_WINDOW_MS;

  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    signedText(userId, mailboxId, url, expiresAt)
  );

  return `${userId}.${expiresAt.toString(36)}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/** The user a valid, unexpired token for `url` in `mailboxId` was issued to, else null. */
export async function verifyRemoteToken(
  secret: string,
  token: string,
  mailboxId: string,
  url: string,
  now = Date.now()
) {
  const signatureAt = token.lastIndexOf(".");
  const expiryAt = token.lastIndexOf(".", signatureAt - 1);

  if (expiryAt <= 0) return null;
  const userId = token.slice(0, expiryAt);
  const expiresAt = Number.parseInt(token.slice(expiryAt + 1, signatureAt), 36);

  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;
  let signature: Uint8Array<ArrayBuffer>;

  try {
    signature = new Uint8Array(base64UrlToBytes(token.slice(signatureAt + 1)));
  } catch {
    return null;
  }

  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature,
    signedText(userId, mailboxId, url, expiresAt)
  );

  return valid ? userId : null;
}
