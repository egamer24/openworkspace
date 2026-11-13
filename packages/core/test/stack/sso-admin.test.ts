import { beforeAll, describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import { DOMParser } from "@xmldom/xmldom";
import { z } from "zod";

import { required } from "../../shared/invariant.ts";
import { SAML_NAMESPACES } from "../../shared/saml.ts";
import { hooks, useFreshWorkspace, worker } from "../../testing/client.ts";
import { internet } from "../../testing/internet.ts";
import type { OutboundHandler } from "../../testing/internet.ts";
import type {
  createOidcClientSchema,
  createSamlApplicationSchema,
} from "../../worker/admin/schemas.ts";
import { hashToken, randomToken } from "../../worker/lib/crypto.ts";

useFreshWorkspace();

const issuer = "http://example.test";
const redirectUri = "https://pkce-optional.example.test/callback";

let cookie: string;

/** The Worker's SAML signing certificate, as Alchemy minted it. */
let idpCertificate: string;

/** The body of a successful response, parsed with `schema`. */
async function json<T>(response: Response, schema: z.ZodType<T>) {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBeLessThan(400);

  return schema.parse(body);
}

function admin(path: string, init: { method?: string; body?: unknown } = {}) {
  const headers = new Headers({ cookie });

  if (init.body !== undefined) headers.set("content-type", "application/json");

  return worker.fetch(
    new Request(`${issuer}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  );
}

const createdOidcClientSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
});

const tokensSchema = z.object({
  access_token: z.string(),
  id_token: z.string(),
});

const metadataDraftSchema = z.object({
  draft: z.looseObject({ entityId: z.string() }),
});

function oidcClientInput(
  overrides: Partial<z.input<typeof createOidcClientSchema>> = {}
) {
  return {
    name: "PKCE choice app",
    clientType: "confidential",
    accessTeams: [{ teamId: "team_everyone" }],
    redirectUris: [redirectUri],
    postLogoutRedirectUris: [],
    allowedOrigins: [],
    allowedScopes: ["openid", "email"],
    trusted: true,
    enabled: true,
    ...overrides,
  };
}

async function authorize(clientId: string, challenge?: string) {
  const url = new URL(`${issuer}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", "state-value");

  if (challenge) {
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }

  const response = await worker.fetch(
    new Request(url, {
      headers: { cookie },
      redirect: "manual",
    })
  );

  expect(response.status).toBe(302);

  return new URL(
    required(response.headers.get("location"), "authorize did not redirect")
  );
}

/** The authorization code a redirect back to the app carries. */
function codeOf(callback: URL) {
  return required(
    callback.searchParams.get("code"),
    `no code in ${callback.toString()}`
  );
}

function tokenRequest(body: Record<string, string>, basic?: string) {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
  });

  if (basic) headers.set("authorization", `Basic ${btoa(basic)}`);

  return worker.fetch(
    new Request(`${issuer}/oauth/token`, {
      method: "POST",
      headers,
      body: new URLSearchParams(body),
    })
  );
}

beforeAll(async () => {
  const bootstrap = await worker.fetch(
    new Request(`${issuer}/api/auth/mock/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Maya Anne Chen",
        email: "sso-admin@example.test",
      }),
    })
  );

  cookie = required(
    required(bootstrap.headers.get("set-cookie"), "bootstrap set no cookie")
      .split(";", 1)
      .at(0),
    "an empty set-cookie header"
  );
  await json(bootstrap, z.unknown());

  idpCertificate = required(
    (await hooks.env("SAML_SIGNING_CERTIFICATE")).SAML_SIGNING_CERTIFICATE,
    "the stack has no SAML signing certificate"
  );
});

/** Answers the Worker's requests to the metadata host; what it fetched there. */
function metadataHost(handler: OutboundHandler) {
  internet.handle((request) =>
    request.target.hostname === "apps.example.com"
      ? handler(request)
      : undefined
  );

  return () =>
    internet.requests.filter(
      (request) => new URL(request.url).hostname === "apps.example.com"
    );
}

/** Refusals of the address itself, before anything is fetched. */
const addressRefused =
  /full https:\/\/ URL|must use https|user name or password|public internet/u;

describe("identity provider details for administrators", () => {
  it("lists the OIDC endpoints and the SAML certificate fingerprint", async () => {
    const state = await json(
      await admin("/api/admin/state"),
      z.object({
        oidcProvider: z.record(
          z.string(),
          z.union([z.string(), z.boolean(), z.null()])
        ),
        samlProvider: z.object({
          configured: z.boolean(),
          certificateFingerprint: z.string(),
          certificateExpiresAt: z.string(),
        }),
      })
    );

    expect(state.oidcProvider).toEqual({
      configured: true,
      issuer,
      discoveryUrl: `${issuer}/.well-known/openid-configuration`,
      authorizationUrl: `${issuer}/oauth/authorize`,
      tokenUrl: `${issuer}/oauth/token`,
      userinfoUrl: `${issuer}/oauth/userinfo`,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      endSessionUrl: `${issuer}/oauth/logout`,
      configurationError: null,
    });
    const certificate = new X509Certificate(idpCertificate);
    expect(state.samlProvider.configured).toBe(true);
    expect(state.samlProvider.certificateFingerprint).toBe(
      certificate.fingerprint256
    );
    expect(state.samlProvider.certificateFingerprint).toMatch(
      /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/u
    );
    expect(Date.parse(state.samlProvider.certificateExpiresAt)).toBe(
      Date.parse(certificate.validTo)
    );
  });

  it("downloads the signing certificate as PEM and DER", async () => {
    const certificate = new X509Certificate(idpCertificate);

    const pem = await admin(
      "/api/admin/saml-applications/idp-certificate?format=pem"
    );

    expect(pem.status).toBe(200);
    expect(pem.headers.get("content-disposition")).toContain(
      "openworkspace-saml.pem"
    );
    expect(new X509Certificate(await pem.text()).fingerprint256).toBe(
      certificate.fingerprint256
    );

    const der = await admin(
      "/api/admin/saml-applications/idp-certificate?format=cer"
    );

    expect(der.status).toBe(200);
    expect(der.headers.get("content-type")).toBe("application/pkix-cert");
    const bytes = Buffer.from(await der.arrayBuffer());
    expect(bytes.equals(certificate.raw)).toBe(true);

    const anonymous = await worker.fetch(
      `${issuer}/api/admin/saml-applications/idp-certificate`
    );

    expect(anonymous.status).toBe(401);
  });
});

describe("optional PKCE and client_secret_post", () => {
  it("lets a confidential app skip PKCE only when it is turned off", async () => {
    const strict = await json(
      await admin("/api/admin/oidc-clients", {
        method: "POST",
        body: oidcClientInput(),
      }),
      createdOidcClientSchema
    );

    const refused = await authorize(strict.clientId);
    expect(refused.searchParams.get("error")).toBe("invalid_request");

    const relaxed = await json(
      await admin("/api/admin/oidc-clients", {
        method: "POST",
        body: oidcClientInput({ name: "No PKCE app", requirePkce: false }),
      }),
      createdOidcClientSchema
    );

    const state = await json(
      await admin("/api/admin/state"),
      z.object({
        oidcClients: z.array(
          z.object({
            id: z.string(),
            requirePkce: z.boolean(),
            managedBy: z.string().nullable(),
          })
        ),
      })
    );

    expect(
      state.oidcClients.find((client) => client.id === relaxed.clientId)
    ).toMatchObject({
      requirePkce: false,
      managedBy: null,
    });

    // Without PKCE, a verifier sent anyway is refused (downgrade protection).
    const withVerifier = await authorize(relaxed.clientId);

    const downgraded = await tokenRequest({
      grant_type: "authorization_code",
      code: codeOf(withVerifier),
      redirect_uri: redirectUri,
      code_verifier: randomToken(48),
      client_id: relaxed.clientId,
      client_secret: relaxed.clientSecret,
    });

    expect(downgraded.status).toBe(400);
    expect(await downgraded.json()).toMatchObject({ error: "invalid_grant" });

    // client_secret_post: the secret in the form body.
    const callback = await authorize(relaxed.clientId);

    const tokens = await json(
      await tokenRequest({
        grant_type: "authorization_code",
        code: codeOf(callback),
        redirect_uri: redirectUri,
        client_id: relaxed.clientId,
        client_secret: relaxed.clientSecret,
      }),
      tokensSchema
    );

    expect(tokens.access_token).toBeTruthy();

    // PKCE still works, and is still checked, when the app sends it.
    const verifier = randomToken(48);
    const pkce = await authorize(relaxed.clientId, await hashToken(verifier));

    const missingVerifier = await tokenRequest(
      {
        grant_type: "authorization_code",
        code: codeOf(pkce),
        redirect_uri: redirectUri,
      },
      `${relaxed.clientId}:${relaxed.clientSecret}`
    );

    expect(missingVerifier.status).toBe(400);
    expect(await missingVerifier.json()).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("rejects two authentication methods at once and a wrong posted secret", async () => {
    const client = await json(
      await admin("/api/admin/oidc-clients", {
        method: "POST",
        body: oidcClientInput({ name: "Two methods app", requirePkce: false }),
      }),
      createdOidcClientSchema
    );

    const callback = await authorize(client.clientId);

    const body = {
      grant_type: "authorization_code",
      code: codeOf(callback),
      redirect_uri: redirectUri,
      client_secret: client.clientSecret,
    };

    const both = await tokenRequest(
      body,
      `${client.clientId}:${client.clientSecret}`
    );

    expect(both.status).toBe(400);

    const wrong = await tokenRequest({
      ...body,
      client_id: client.clientId,
      client_secret: "wrong",
    });

    expect(wrong.status).toBe(401);
  });

  it("keeps PKCE on for public clients and advertises client_secret_post", async () => {
    const client = await json(
      await admin("/api/admin/oidc-clients", {
        method: "POST",
        body: oidcClientInput({
          name: "Phone app",
          clientType: "public",
          requirePkce: false,
        }),
      }),
      z.object({ clientId: z.string() })
    );

    const state = await json(
      await admin("/api/admin/state"),
      z.object({
        oidcClients: z.array(
          z.object({ id: z.string(), requirePkce: z.boolean() })
        ),
      })
    );

    expect(
      state.oidcClients.find((item) => item.id === client.clientId)?.requirePkce
    ).toBe(true);
    const refused = await authorize(client.clientId);
    expect(refused.searchParams.get("error")).toBe("invalid_request");

    const discovery = await json(
      await worker.fetch(`${issuer}/.well-known/openid-configuration`),
      z.object({ token_endpoint_auth_methods_supported: z.array(z.string()) })
    );

    expect(discovery.token_endpoint_auth_methods_supported).toEqual([
      "client_secret_basic",
      "client_secret_post",
      "none",
    ]);
  });
});

// The service provider's own signing certificate.
const spCertificate = readFileSync(
  new URL("../fixtures/saml-certificate.pem", import.meta.url),
  "utf-8"
);

const spCertificateBody = new X509Certificate(spCertificate).raw.toString(
  "base64"
);

function spMetadata(entityId = "https://sp.metadata.example.test/saml") {
  return `<?xml version="1.0"?>
<md:EntitiesDescriptor xmlns:md="${SAML_NAMESPACES.metadata}">
  <md:EntityDescriptor entityID="https://idp.elsewhere.example.test">
    <md:IDPSSODescriptor protocolSupportEnumeration="${SAML_NAMESPACES.protocol}"/>
  </md:EntityDescriptor>
  <md:EntityDescriptor entityID="${entityId}">
    <md:SPSSODescriptor AuthnRequestsSigned="true" protocolSupportEnumeration="${SAML_NAMESPACES.protocol}">
      <md:KeyDescriptor use="encryption"><ds:KeyInfo xmlns:ds="${SAML_NAMESPACES.signature}"><ds:X509Data><ds:X509Certificate>bm90IGEgY2VydGlmaWNhdGU=</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
      <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="${SAML_NAMESPACES.signature}"><ds:X509Data><ds:X509Certificate>${spCertificateBody}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
      <md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:transient</md:NameIDFormat>
      <md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat>
      <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Artifact" Location="https://sp.metadata.example.test/artifact" index="0"/>
      <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.metadata.example.test/acs/2" index="2"/>
      <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.metadata.example.test/acs/1" index="1"/>
    </md:SPSSODescriptor>
    <md:Organization><md:OrganizationName xml:lang="en">Example</md:OrganizationName><md:OrganizationDisplayName xml:lang="en">Metadata App</md:OrganizationDisplayName><md:OrganizationURL xml:lang="en">https://example.test</md:OrganizationURL></md:Organization>
  </md:EntityDescriptor>
</md:EntitiesDescriptor>`;
}

describe("service provider metadata import", () => {
  it("reads an uploaded file into a draft", async () => {
    const result = await json(
      await admin("/api/admin/saml-applications/parse-metadata", {
        method: "POST",
        body: { xml: spMetadata() },
      }),
      z.object({
        draft: z.looseObject({ spSigningCertificate: z.string() }),
      })
    );

    expect(result.draft).toMatchObject({
      name: "Metadata App",
      entityId: "https://sp.metadata.example.test/saml",
      acsUrl: "https://sp.metadata.example.test/acs/1",
      nameIdFormat: "persistent",
      requireSignedAuthnRequests: true,
      warnings: [],
    });
    expect(
      new X509Certificate(result.draft.spSigningCertificate).fingerprint256
    ).toBe(new X509Certificate(spCertificate).fingerprint256);
  });

  it("fetches a public HTTPS address, following a checked redirect", async () => {
    const fetched = metadataHost((request) => {
      const { url } = request;

      if (url === "https://apps.example.com/metadata") {
        return new Response(null, {
          status: 302,
          headers: { location: "/saml/metadata.xml" },
        });
      }

      if (url === "https://apps.example.com/saml/metadata.xml") {
        return new Response(spMetadata("urn:amazon:webservices"), {
          headers: { "content-type": "application/samlmetadata+xml" },
        });
      }

      return new Response("unexpected", { status: 500 });
    });

    const result = await json(
      await admin("/api/admin/saml-applications/parse-metadata", {
        method: "POST",
        body: { url: "https://apps.example.com/metadata" },
      }),
      metadataDraftSchema
    );

    expect(result.draft.entityId).toBe("urn:amazon:webservices");
    expect(fetched()).toHaveLength(2);
  });

  it.each([
    "http://apps.example.com/metadata",
    "https://localhost/metadata",
    "https://127.0.0.1/metadata",
    "https://10.1.2.3/metadata",
    "https://169.254.169.254/latest/meta-data",
    "https://192.168.1.10/metadata",
    "https://[::1]/metadata",
    "https://[fd00::1]/metadata",
    "https://intranet/metadata",
    "https://printer.local/metadata",
    "https://user:secret@apps.example.com/metadata",
  ])("refuses to fetch %s", async (url) => {
    const fetched = metadataHost(() => new Response(spMetadata()));

    const response = await admin(
      "/api/admin/saml-applications/parse-metadata",
      {
        method: "POST",
        body: { url },
      }
    );

    expect(response.status).toBe(400);
    // Loopback addresses would not reach the test process, so the refusal
    // itself shows nothing was fetched.
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringMatching(addressRefused) },
    });
    expect(fetched()).toEqual([]);
  });

  it("refuses redirects to private hosts and oversized documents", async () => {
    metadataHost(
      () =>
        new Response(null, {
          status: 301,
          headers: { location: "https://127.0.0.1/metadata" },
        })
    );

    const redirected = await admin(
      "/api/admin/saml-applications/parse-metadata",
      {
        method: "POST",
        body: { url: "https://apps.example.com/metadata" },
      }
    );

    expect(redirected.status).toBe(400);

    internet.reset();
    metadataHost(() => new Response("<a>".padEnd(600 * 1024, " ")));

    const large = await admin("/api/admin/saml-applications/parse-metadata", {
      method: "POST",
      body: { url: "https://apps.example.com/metadata" },
    });

    expect(large.status).toBe(400);
    expect(await large.json()).toMatchObject({
      error: { message: expect.stringContaining("512 KB") },
    });
  });

  it("refuses documents with entity declarations or without a service provider", async () => {
    const responses = await Promise.all(
      [
        `<!DOCTYPE x [<!ENTITY a "b">]><md:EntityDescriptor xmlns:md="${SAML_NAMESPACES.metadata}" entityID="https://x.example.test"/>`,
        `<md:EntityDescriptor xmlns:md="${SAML_NAMESPACES.metadata}" entityID="https://x.example.test"><md:IDPSSODescriptor/></md:EntityDescriptor>`,
        "<html></html>",
      ].map((xml) =>
        admin("/api/admin/saml-applications/parse-metadata", {
          method: "POST",
          body: { xml },
        })
      )
    );

    expect(responses.map((response) => response.status)).toEqual([
      400, 400, 400,
    ]);
  });
});

describe("SAML entity IDs and name attributes", () => {
  function samlInput(
    overrides: Partial<z.input<typeof createSamlApplicationSchema>>
  ) {
    return {
      name: "Entity app",
      entityId: "https://entity.example.test",
      acsUrl: "https://entity.example.test/acs",
      nameIdFormat: "email",
      accessTeams: [{ teamId: "team_everyone" }],
      emailAttributeName: "email",
      nameAttributeName: "name",
      groupsAttributeName: "groups",
      signResponse: true,
      requireSignedAuthnRequests: false,
      spSigningCertificate: null,
      allowIdpInitiated: true,
      enabled: true,
      ...overrides,
    };
  }

  it("accepts URNs and plain names, and sends first and last names", async () => {
    // Separate apps, each with its own Entity ID and ACS URL.
    await Promise.all(
      ["urn:amazon:webservices", "google.com", "google.com/a/example.com"].map(
        async (entityId) =>
          json(
            await admin("/api/admin/saml-applications", {
              method: "POST",
              body: samlInput({
                entityId,
                acsUrl: `https://acs.example.test/${encodeURIComponent(entityId)}`,
              }),
            }),
            z.unknown()
          )
      )
    );

    const refused = await Promise.all(
      ["has space", "<script>", "javascript"].map((entityId) =>
        admin("/api/admin/saml-applications", {
          method: "POST",
          body: samlInput({ entityId }),
        })
      )
    );

    expect(refused.map((response) => response.status)).toEqual([400, 400, 400]);

    const created = await json(
      await admin("/api/admin/saml-applications", {
        method: "POST",
        body: samlInput({
          entityId: "https://names.example.test",
          acsUrl: "https://names.example.test/acs",
          firstNameAttributeName: "givenName",
          lastNameAttributeName: "familyName",
        }),
      }),
      z.object({ applicationId: z.string() })
    );

    const launch = await worker.fetch(
      new Request(`${issuer}/saml/launch/${created.applicationId}`, {
        headers: { cookie },
        redirect: "manual",
      })
    );

    const html = await launch.text();
    const encoded = html.match(/name="SAMLResponse" value="([^"]+)"/u)?.[1];
    expect(encoded, html).toBeTruthy();

    const document = new DOMParser().parseFromString(
      Buffer.from(
        required(encoded, "the launch page has no SAMLResponse"),
        "base64"
      ).toString("utf-8"),
      "application/xml"
    );

    const attributes = Object.fromEntries(
      Array.from(
        document.getElementsByTagNameNS(SAML_NAMESPACES.assertion, "Attribute")
      ).map((element) => [
        element.getAttribute("Name"),
        element
          .getElementsByTagNameNS(SAML_NAMESPACES.assertion, "AttributeValue")
          .item(0)?.textContent,
      ])
    );

    expect(attributes).toMatchObject({
      name: "Maya Anne Chen",
      givenName: "Maya Anne",
      familyName: "Chen",
    });

    const state = await json(
      await admin("/api/admin/state"),
      z.object({
        samlApplications: z.array(
          z.object({
            id: z.string(),
            firstNameAttributeName: z.string().nullable(),
          })
        ),
      })
    );

    expect(
      state.samlApplications.find((item) => item.id === created.applicationId)
    ).toMatchObject({
      firstNameAttributeName: "givenName",
    });
  });
});
