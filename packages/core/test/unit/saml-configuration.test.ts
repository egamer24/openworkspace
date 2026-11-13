import { describe, expect, it, spyOn } from "bun:test";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import type { AppEnv } from "../../worker/env.ts";
import { samlConfiguration } from "../../worker/saml/configuration.ts";
import { samlMetadata } from "../../worker/saml/metadata.ts";

const certificatePem = readFileSync(
  new URL("../fixtures/saml-certificate.pem", import.meta.url),
  "utf-8"
);

// A deployment's SAML bindings: its origin, key, and certificate.
// SAFETY: samlConfiguration reads only the origin, mock-auth flag, and SAML signing bindings set here.
const env = {
  IDENTITY_PROVIDER_ORIGIN: "http://example.test",
  ALLOW_MOCK_AUTH: "true",
  SAML_SIGNING_PRIVATE_KEY: readFileSync(
    new URL("../fixtures/saml-private-key.pem", import.meta.url),
    "utf-8"
  ),
  SAML_SIGNING_CERTIFICATE: certificatePem,
} as AppEnv["Bindings"];

describe("SAML signing configuration", () => {
  it("publishes only the validated certificate from a PEM chain", () => {
    const certificate = new X509Certificate(certificatePem);

    const configuration = samlConfiguration({
      ...env,
      SAML_SIGNING_CERTIFICATE: `${certificatePem}\n${certificatePem}`,
    });

    expect(configuration.certificateBody).toBe(
      certificate.raw.toString("base64")
    );
  });

  it("publishes the signing certificate in the metadata", () => {
    const configuration = samlConfiguration(env);
    const metadata = samlMetadata(configuration);

    expect(metadata.match(/<md:KeyDescriptor use="signing">/gu)).toHaveLength(
      1
    );
    expect(metadata).toContain(
      `<ds:X509Certificate>${configuration.certificateBody}</ds:X509Certificate>`
    );
  });

  it("revalidates a cached signing certificate after it expires", () => {
    samlConfiguration(env);
    const certificate = new X509Certificate(certificatePem);

    const now = spyOn(Date, "now").mockReturnValue(
      Date.parse(certificate.validTo) + 1
    );

    try {
      expect(() => samlConfiguration(env)).toThrow(
        "SAML signing key or certificate is invalid"
      );
    } finally {
      now.mockRestore();
    }
  });
});
