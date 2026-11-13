/**
 * A software passkey for stack tests: answers WebAuthn registrations the
 * way a platform authenticator does with attestation "none" (an ES256 key,
 * user present and verified) and signs assertions, so tests can finish real
 * passkey ceremonies (first-administrator setup, invitations, recovery,
 * sign-in) against the Worker, or tamper with one to see it refused.
 */

import { required } from "../../shared/invariant.ts";

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/u, "");
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0)
  );

  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

/** The CBOR head of a major type and length (RFC 8949), for what a passkey sends. */
function cborHead(major: number, value: number) {
  if (value < 24) return Uint8Array.of((major << 5) | value);

  if (value < 0x1_00) return Uint8Array.of((major << 5) | 24, value);

  if (value < 0x1_00_00) {
    return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff);
  }

  throw new Error("CBOR value too large for this encoder");
}

/** A CBOR integer (major type 0 or 1). */
function cborInt(value: number) {
  return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
}

/** A CBOR text string (major type 3). */
function cborText(value: string) {
  const bytes = new TextEncoder().encode(value);

  return concat(cborHead(3, bytes.length), bytes);
}

/** A CBOR byte string (major type 2). */
function cborBytes(value: Uint8Array) {
  return concat(cborHead(2, value.length), value);
}

/** A CBOR map (major type 5) of already encoded keys and values. */
function cborMap(entries: [key: Uint8Array, value: Uint8Array][]) {
  return concat(cborHead(5, entries.length), ...entries.flat());
}

/** Flags in authenticator data (WebAuthn §6.1): user present, user verified, attested credential data. */
export const UP = 0x01;
export const UV = 0x04;
const AT = 0x40;

const fromBase64Url = (value: string) =>
  Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0)
  );

/** A DER INTEGER for one half of a raw ECDSA signature: leading zeros dropped, a zero added for the sign bit. */
function derInteger(bytes: Uint8Array) {
  let start = 0;

  while (start < bytes.length - 1 && bytes[start] === 0) start++;

  const value =
    required(bytes[start], "a signature half has bytes") & 0x80
      ? concat(Uint8Array.of(0), bytes.slice(start))
      : bytes.slice(start);

  return concat(Uint8Array.of(0x02, value.length), value);
}

/** WebCrypto signs ECDSA as r‖s; WebAuthn's ES256 signatures are DER (RFC 3279). */
function derSignature(raw: Uint8Array) {
  const body = concat(derInteger(raw.slice(0, 32)), derInteger(raw.slice(32)));

  return concat(Uint8Array.of(0x30, body.length), body);
}

/** What a ceremony may get wrong, to check that the Worker refuses it. */
export type Tamper = {
  /** clientDataJSON's origin, instead of the one the ceremony runs on. */
  origin?: string;
  /** The RP ID whose hash goes in authenticator data. */
  rpId?: string;
  /** clientDataJSON's challenge, instead of the options' one. */
  challenge?: string;
  /** Authenticator data flags; UP|UV by default. */
  flags?: number;
  /** The signature counter an assertion reports; one more than the last by default. */
  counter?: number;
  /** Sign with a different key than the registered one. */
  wrongKey?: boolean;
};

/**
 * A software authenticator holding one ES256 passkey: it answers a
 * registration the way a platform authenticator does with attestation
 * "none", then signs assertions for that credential, counting up.
 */
export async function softwarePasskey() {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );

  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const id = base64Url(credentialId);
  let counter = 0;

  const rpIdHash = async (rpId: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId))
    );

  const clientData = (type: string, challenge: string, origin: string) =>
    new TextEncoder().encode(
      JSON.stringify({ type, challenge, origin, crossOrigin: false })
    );

  return {
    id,
    /** The registration response for `options` (from a `/options` route), as the browser sends it to `/verify`. */
    async register(
      options: { challenge: string; rp: { id?: string } },
      origin: string,
      tamper: Tamper = {}
    ) {
      const rpId = tamper.rpId ?? options.rp.id ?? new URL(origin).hostname;
      const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);

      const coseKey = cborMap([
        [cborInt(1), cborInt(2)], // kty: EC2
        [cborInt(3), cborInt(-7)], // alg: ES256
        [cborInt(-1), cborInt(1)], // crv: P-256
        [
          cborInt(-2),
          cborBytes(fromBase64Url(required(jwk.x, "an EC key's x"))),
        ],
        [
          cborInt(-3),
          cborBytes(fromBase64Url(required(jwk.y, "an EC key's y"))),
        ],
      ]);

      const authData = concat(
        await rpIdHash(rpId),
        Uint8Array.of((tamper.flags ?? UP | UV) | AT),
        new Uint8Array(4), // sign count
        new Uint8Array(16), // AAGUID
        Uint8Array.of(credentialId.length >> 8, credentialId.length & 0xff),
        credentialId,
        coseKey
      );

      const attestationObject = cborMap([
        [cborText("fmt"), cborText("none")],
        [cborText("attStmt"), cborMap([])],
        [cborText("authData"), cborBytes(authData)],
      ]);

      return {
        id,
        rawId: id,
        type: "public-key" as const,
        response: {
          clientDataJSON: base64Url(
            clientData(
              "webauthn.create",
              tamper.challenge ?? options.challenge,
              tamper.origin ?? origin
            )
          ),
          attestationObject: base64Url(attestationObject),
          transports: ["internal"],
        },
        clientExtensionResults: {},
      };
    },
    /** The authentication response for `options` (from `/api/auth/login/options`), as the browser sends it to `/verify`. */
    async authenticate(
      options: { challenge: string; rpId?: string },
      origin: string,
      tamper: Tamper = {}
    ) {
      const rpId = tamper.rpId ?? options.rpId ?? new URL(origin).hostname;
      const signCount = tamper.counter ?? ++counter;

      const authData = concat(
        await rpIdHash(rpId),
        Uint8Array.of(tamper.flags ?? UP | UV),
        Uint8Array.of(
          signCount >>> 24,
          (signCount >>> 16) & 0xff,
          (signCount >>> 8) & 0xff,
          signCount & 0xff
        )
      );

      const clientDataJSON = clientData(
        "webauthn.get",
        tamper.challenge ?? options.challenge,
        tamper.origin ?? origin
      );

      const clientDataHash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", clientDataJSON)
      );

      const signer = tamper.wrongKey
        ? (
            await crypto.subtle.generateKey(
              { name: "ECDSA", namedCurve: "P-256" },
              false,
              ["sign"]
            )
          ).privateKey
        : keys.privateKey;

      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          signer,
          concat(authData, clientDataHash)
        )
      );

      return {
        id,
        rawId: id,
        type: "public-key" as const,
        response: {
          clientDataJSON: base64Url(clientDataJSON),
          authenticatorData: base64Url(authData),
          signature: base64Url(derSignature(signature)),
        },
        clientExtensionResults: {},
      };
    },
  };
}

/**
 * The registration response for `options` (from a `/options` route) as the
 * browser sends it to the matching `/verify` route, from a new passkey.
 */
export async function passkeyRegistration(
  options: { challenge: string; rp: { id?: string } },
  origin: string
) {
  return (await softwarePasskey()).register(options, origin);
}
