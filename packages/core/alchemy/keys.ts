// @peculiar/x509 needs a Reflect metadata polyfill loaded before it (since v2).
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import type { ResourceClass } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { z } from "zod";

/*
 * Signing material the Worker needs, minted once by Alchemy and kept in the
 * stack's state, like `Alchemy.Random`: later deploys reuse the stored value.
 * Rotating one means replacing the resource (give it a new id), which
 * signs out SSO apps that pinned the old key and asks devices to turn push
 * notifications on again.
 */

const RSA_SIGNING = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
} as const;

function base64Url(bytes: ArrayBuffer | Uint8Array) {
  return Buffer.from(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  ).toString("base64url");
}

function pem(label: string, der: ArrayBuffer) {
  const body = Buffer.from(der)
    .toString("base64")
    .replaceAll(/.{64}(?=.)/gu, "$&\n");

  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

export type SigningCertificateProps = {
  /** Subject common name; defaults to "OpenWorkspace SAML". */
  commonName?: string;
  /** How long the certificate is valid; defaults to ten years. */
  validityDays?: number;
};

/** A 2048-bit RSA key and a self-signed X.509 certificate for it. */
export type SigningCertificate = Resource<
  "OpenWorkspace.SigningCertificate",
  SigningCertificateProps,
  {
    /** PKCS #8 PEM. */
    privateKey: Redacted.Redacted<string>;
    /** PEM. */
    certificate: string;
    notAfter: string;
  }
>;

/**
 * SAML signing credentials. SSO apps pin the certificate, so it is not
 * renewed on its own; the default ten years outlives most deployments.
 */
export const SigningCertificate = Resource<SigningCertificate>(
  "OpenWorkspace.SigningCertificate"
);

/** An RS256 private JWK whose `kid` is its RFC 7638 thumbprint. */
export type OidcSigningKey = Resource<
  "OpenWorkspace.OidcSigningKey",
  Record<string, never>,
  { privateJwk: Redacted.Redacted<string>; kid: string }
>;

/** The key that signs OIDC ID tokens. */
export const OidcSigningKey = Resource<OidcSigningKey>(
  "OpenWorkspace.OidcSigningKey"
);

/** Web Push application server keys, base64url as browsers take them. */
export type VapidKeys = Resource<
  "OpenWorkspace.VapidKeys",
  Record<string, never>,
  { publicKey: string; privateKey: Redacted.Redacted<string> }
>;

/** The P-256 key pair that identifies the server to push services. */
export const VapidKeys = Resource<VapidKeys>("OpenWorkspace.VapidKeys");

async function signingCertificate(props: SigningCertificateProps) {
  const keys = await crypto.subtle.generateKey(RSA_SIGNING, true, [
    "sign",
    "verify",
  ]);

  const notBefore = new Date();

  const notAfter = new Date(
    notBefore.getTime() + (props.validityDays ?? 3650) * 86_400_000
  );

  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: Buffer.from(crypto.getRandomValues(new Uint8Array(16)))
      .toString("hex")
      .replace(/^[89a-f]/u, "7"),
    name: [{ CN: [props.commonName ?? "OpenWorkspace SAML"] }],
    notBefore,
    notAfter,
    signingAlgorithm: RSA_SIGNING,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });

  return {
    privateKey: Redacted.make(
      pem(
        "PRIVATE KEY",
        await crypto.subtle.exportKey("pkcs8", keys.privateKey)
      )
    ),
    certificate: certificate.toString("pem"),
    notAfter: notAfter.toISOString(),
  };
}

async function oidcSigningKey() {
  const pair = await crypto.subtle.generateKey(RSA_SIGNING, true, [
    "sign",
    "verify",
  ]);

  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);

  const thumbprint = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })
    )
  );

  const kid = base64Url(thumbprint);
  const { key_ops: _ops, ext: _ext, ...rest } = jwk;

  return {
    privateJwk: Redacted.make(
      JSON.stringify({ ...rest, alg: "RS256", use: "sig", kid })
    ),
    kid,
  };
}

/** An exported P-256 private key: its public point and private scalar. */
const ecPrivateJwkSchema = z.object({
  x: z.string(),
  y: z.string(),
  d: z.string(),
});

async function vapidKeys() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );

  const jwk = ecPrivateJwkSchema.parse(
    await crypto.subtle.exportKey("jwk", pair.privateKey)
  );

  // The uncompressed public point: 0x04 || x || y.
  const point = new Uint8Array(65);
  point[0] = 4;
  point.set(Buffer.from(jwk.x, "base64url"), 1);
  point.set(Buffer.from(jwk.y, "base64url"), 33);

  return { publicKey: base64Url(point), privateKey: Redacted.make(jwk.d) };
}

/**
 * A provider for material that only lives in state: the stored value wins,
 * and there is nothing remote to read, delete, or list.
 */
function mintedOnce<R extends SigningCertificate | OidcSigningKey | VapidKeys>(
  resource: ResourceClass<R>,
  mint: (props: R["Props"]) => Promise<R["Attributes"]>
) {
  return Provider.succeed(resource, {
    reconcile: ({
      news,
      output,
    }: {
      news?: R["Props"];
      output?: R["Attributes"];
    }) =>
      output ? Effect.succeed(output) : Effect.promise(() => mint(news ?? {})),
    delete: () => Effect.void,
    read: ({ output }: { output?: R["Attributes"] }) => Effect.succeed(output),
    list: () => Effect.succeed([]),
  });
}

/** Providers for the resources above; merge them into the stack's providers. */
export const keyProviders = () =>
  Layer.mergeAll(
    mintedOnce<SigningCertificate>(SigningCertificate, signingCertificate),
    mintedOnce<OidcSigningKey>(OidcSigningKey, oidcSigningKey),
    mintedOnce<VapidKeys>(VapidKeys, vapidKeys)
  );
