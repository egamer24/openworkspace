import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import { deflateRawSync } from "node:zlib";

import { SAML_BINDINGS, SAML_NAMESPACES } from "../../shared/saml.ts";
import {
  createInvitationSchema,
  createSamlApplicationSchema,
  updateUserSchema,
} from "../../worker/admin/schemas.ts";
import { bootstrapInputSchema } from "../../worker/auth/schemas.ts";
import { samlPublicUrls } from "../../worker/saml/configuration.ts";
import { isSupportedSamlRsaKey } from "../../worker/saml/credentials.ts";
import { parseRedirectAuthnRequest } from "../../worker/saml/request.ts";

const validSamlApplication = {
  name: "Example application",
  entityId: "https://sp.example.test/metadata",
  acsUrl: "https://sp.example.test/saml/acs",
  nameIdFormat: "email" as const,
  accessTeams: [{ teamId: "team_everyone" }],
  emailAttributeName: "email",
  nameAttributeName: "name",
  groupsAttributeName: "groups",
  signResponse: true,
  requireSignedAuthnRequests: false,
  spSigningCertificate: null,
  allowIdpInitiated: true,
  enabled: true,
};

function redirectRequestUrl(xml: string) {
  const url = new URL("https://idp.example.test/saml/sso");
  url.searchParams.set(
    "SAMLRequest",
    deflateRawSync(Buffer.from(xml, "utf-8")).toString("base64")
  );

  return url;
}

describe("SAML input validation", () => {
  it("rejects RSA keys smaller than 2048 bits", () => {
    const weak = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey;

    const supported = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }).publicKey;

    expect(isSupportedSamlRsaKey(weak)).toBe(false);
    expect(isSupportedSamlRsaKey(supported)).toBe(true);
  });

  it.each([
    "not a URL",
    "https://user:password@idp.example.test",
    "https://idp.example.test/path",
  ])("rejects an invalid public IdP origin: %s", (origin) => {
    expect(() =>
      samlPublicUrls({
        IDENTITY_PROVIDER_ORIGIN: origin,
        ALLOW_MOCK_AUTH: "false",
      })
    ).toThrow(/Identity provider origin/u);
  });

  it("only permits HTTP as the mock IdP protocol", () => {
    expect(
      samlPublicUrls({
        IDENTITY_PROVIDER_ORIGIN: "http://idp.example.test",
        ALLOW_MOCK_AUTH: "true",
      }).origin
    ).toBe("http://idp.example.test");
    expect(() =>
      samlPublicUrls({
        IDENTITY_PROVIDER_ORIGIN: "ftp://idp.example.test",
        ALLOW_MOCK_AUTH: "true",
      })
    ).toThrow(/Identity provider origin/u);
  });

  it("rejects an AuthnRequest with a targeted Subject", () => {
    const xml =
      `<samlp:AuthnRequest xmlns:samlp="${SAML_NAMESPACES.protocol}" xmlns:saml="${SAML_NAMESPACES.assertion}" ID="request_subject" Version="2.0" IssueInstant="${new Date().toISOString()}" AssertionConsumerServiceURL="${validSamlApplication.acsUrl}" ProtocolBinding="${SAML_BINDINGS.post}">` +
      `<saml:Issuer>${validSamlApplication.entityId}</saml:Issuer>` +
      `<saml:Subject><saml:NameID>victim@example.test</saml:NameID></saml:Subject>` +
      `</samlp:AuthnRequest>`;

    expect(() => parseRedirectAuthnRequest(redirectRequestUrl(xml))).toThrow(
      "AuthnRequest Subject is not supported"
    );
  });

  it.each(["relay\0state", "relay\u0001state"])(
    "rejects XML-invalid RelayState %#",
    (relayState) => {
      const xml =
        `<samlp:AuthnRequest xmlns:samlp="${SAML_NAMESPACES.protocol}" xmlns:saml="${SAML_NAMESPACES.assertion}" ID="request_relay" Version="2.0" IssueInstant="${new Date().toISOString()}" AssertionConsumerServiceURL="${validSamlApplication.acsUrl}" ProtocolBinding="${SAML_BINDINGS.post}">` +
        `<saml:Issuer>${validSamlApplication.entityId}</saml:Issuer>` +
        `</samlp:AuthnRequest>`;

      const url = redirectRequestUrl(xml);
      url.searchParams.set("RelayState", relayState);

      expect(() => parseRedirectAuthnRequest(url)).toThrow(
        "RelayState is invalid"
      );
    }
  );

  it.each([
    ["entityId", `https://sp.example.test/metadata\0suffix`],
    ["acsUrl", `https://sp.example.test/saml/acs\0suffix`],
    ["emailAttributeName", "email\0suffix"],
    ["nameAttributeName", "name\0suffix"],
    ["groupsAttributeName", "groups\0suffix"],
  ] as const)("rejects XML-invalid SAML field %s", (field, value) => {
    expect(
      createSamlApplicationSchema.safeParse({
        ...validSamlApplication,
        [field]: value,
      }).success
    ).toBe(false);
  });

  it("rejects XML-invalid user names at every write boundary", () => {
    const name = "Invalid\0Name";
    expect(
      bootstrapInputSchema.safeParse({
        name,
        email: "bootstrap@example.test",
      }).success
    ).toBe(false);
    expect(
      createInvitationSchema.safeParse({
        name,
        email: "invited@example.test",
      }).success
    ).toBe(false);
    expect(updateUserSchema.safeParse({ name }).success).toBe(false);
  });
});
