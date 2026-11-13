import { beforeAll, describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import { sign, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";

import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import { z } from "zod";

import { required } from "../../shared/invariant.ts";
import {
  SAML_AUTHN_CONTEXT_UNSPECIFIED,
  SAML_BINDINGS,
  SAML_NAMESPACES,
  samlNameIdFormatUris,
} from "../../shared/saml.ts";
import { env, hooks, useFreshWorkspace, worker } from "../../testing/client.ts";

useFreshWorkspace();

const origin = "http://example.test";

/** The Worker's SAML signing certificate, as Alchemy minted it. */
let idpCertificate: string;

beforeAll(async () => {
  idpCertificate = required(
    (await hooks.env("SAML_SIGNING_CERTIFICATE")).SAML_SIGNING_CERTIFICATE,
    "the stack has no SAML signing certificate"
  );
});

/** A service provider's own key pair, for signed AuthnRequests. */
const spCertificate = readFileSync(
  new URL("../fixtures/saml-certificate.pem", import.meta.url),
  "utf-8"
);

const spPrivateKey = readFileSync(
  new URL("../fixtures/saml-private-key.pem", import.meta.url),
  "utf-8"
);

/** The body of a successful response, parsed with `schema`. */
async function successfulJson<T>(response: Response, schema: z.ZodType<T>) {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBeLessThan(400);

  return schema.parse(body);
}

const applicationCreatedSchema = z.object({ applicationId: z.string() });

const loginPreviewSchema = z.object({
  transaction: z.object({ applicationName: z.string() }),
});

/** `name=value` of each cookie a response sets. */
function setCookies(response: Response) {
  return response.headers
    .getSetCookie()
    .flatMap((value) => value.split(";", 1));
}

function sessionCookie(response: Response) {
  return required(
    setCookies(response).at(0),
    `no cookie set (${response.status})`
  );
}

function responseCookie(response: Response, name: string) {
  return setCookies(response).find((value) => value.startsWith(`${name}=`));
}

/** The last path segment of a redirect: the id it names. */
function redirectId(response: Response) {
  const location = required(
    response.headers.get("location"),
    `no redirect (${response.status})`
  );

  return {
    location,
    id: required(location.split("/").at(-1), `no id in ${location}`),
  };
}

function samlTransactionCookieName(requestId: string) {
  return `op_saml_${requestId}`;
}

function samlResponseXml(html: string) {
  const encoded = html.match(/name="SAMLResponse" value="([^"]+)"/u)?.[1];
  expect(encoded).toBeTruthy();

  return Buffer.from(
    required(encoded, "no SAMLResponse in the page"),
    "base64"
  ).toString("utf-8");
}

function samlNameId(xml: string) {
  const document = new DOMParser().parseFromString(xml, "application/xml");

  return document
    .getElementsByTagNameNS(SAML_NAMESPACES.assertion, "NameID")
    .item(0)?.textContent;
}

function expectValidSignature(
  xml: string,
  localName: "Response" | "Assertion"
) {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const root = document.documentElement;

  if (!root) throw new Error("SAML response has no document element");

  const signedElement = required(
    localName === "Response"
      ? root
      : root
          .getElementsByTagNameNS(SAML_NAMESPACES.assertion, "Assertion")
          .item(0),
    `SAML response has no ${localName}`
  );

  const signature = Array.from(signedElement.childNodes).find(
    (node) =>
      node.nodeType === 1 &&
      node.namespaceURI === SAML_NAMESPACES.signature &&
      node.localName === "Signature"
  );

  const verifier = new SignedXml({
    publicCert: idpCertificate,
    getCertFromKeyInfo: () => null,
  });

  verifier.loadSignature(
    new XMLSerializer().serializeToString(
      required(signature, `the ${localName} is not signed`)
    )
  );
  expect(verifier.checkSignature(xml)).toBe(true);
  expect(verifier.getSignedReferences()).toHaveLength(1);
}

function authnRequest(input: {
  id: string;
  issuer: string;
  acsUrl: string;
  destination?: string | null;
  forceAuthn?: boolean;
  isPassive?: boolean;
  nameIdPolicy?: {
    format?: string;
    allowCreate?: boolean;
    spNameQualifier?: string;
  };
  requestedAuthnContext?: {
    comparison?: "exact" | "minimum" | "maximum" | "better";
    classRefs: string[];
  };
}) {
  const destination =
    input.destination === null
      ? ""
      : ` Destination="${input.destination ?? `${origin}/saml/sso`}"`;

  const forceAuthn =
    input.forceAuthn === undefined ? "" : ` ForceAuthn="${input.forceAuthn}"`;

  const isPassive =
    input.isPassive === undefined ? "" : ` IsPassive="${input.isPassive}"`;

  const nameIdPolicy = input.nameIdPolicy
    ? `<samlp:NameIDPolicy${input.nameIdPolicy.format ? ` Format="${input.nameIdPolicy.format}"` : ""}${input.nameIdPolicy.allowCreate === undefined ? "" : ` AllowCreate="${input.nameIdPolicy.allowCreate}"`}${input.nameIdPolicy.spNameQualifier ? ` SPNameQualifier="${input.nameIdPolicy.spNameQualifier}"` : ""}/>`
    : "";

  const requestedAuthnContext = input.requestedAuthnContext
    ? `<samlp:RequestedAuthnContext Comparison="${input.requestedAuthnContext.comparison ?? "exact"}">${input.requestedAuthnContext.classRefs.map((reference) => `<saml:AuthnContextClassRef>${reference}</saml:AuthnContextClassRef>`).join("")}</samlp:RequestedAuthnContext>`
    : "";

  const xml = `<samlp:AuthnRequest xmlns:samlp="${SAML_NAMESPACES.protocol}" xmlns:saml="${SAML_NAMESPACES.assertion}" ID="${input.id}" Version="2.0" IssueInstant="${new Date().toISOString()}"${destination}${forceAuthn}${isPassive} AssertionConsumerServiceURL="${input.acsUrl}" ProtocolBinding="${SAML_BINDINGS.post}"><saml:Issuer>${input.issuer}</saml:Issuer>${nameIdPolicy}${requestedAuthnContext}</samlp:AuthnRequest>`;

  return deflateRawSync(Buffer.from(xml, "utf-8")).toString("base64");
}

async function samlFixture(suffix: string) {
  const email = `saml-${suffix}@example.test`;

  const bootstrap = await worker.fetch(
    new Request(`${origin}/api/auth/mock/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "SAML Admin",
        email,
      }),
    })
  );

  const cookie = sessionCookie(bootstrap);
  await successfulJson(bootstrap, z.unknown());

  const state = await successfulJson(
    await worker.fetch(
      new Request(`${origin}/api/admin/state`, { headers: { cookie } })
    ),
    z.object({
      users: z.array(z.object({ id: z.string() })),
      samlProvider: z.object({ configured: z.boolean(), entityId: z.string() }),
    })
  );

  const userId = required(state.users[0], "the workspace has no users").id;
  const groupSlug = `engineering-${suffix}`;

  const group = await successfulJson(
    await worker.fetch(
      new Request(`${origin}/api/admin/teams`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Engineering",
          slug: groupSlug,
          description: null,
          members: [{ userId, canSend: true }],
        }),
      })
    ),
    z.object({ teamId: z.string() })
  );

  const entityId = `https://${suffix}.service.example.test/saml/metadata`;
  const acsUrl = `https://${suffix}.service.example.test/saml/acs`;

  const applicationInput = {
    name: "Example service",
    entityId,
    acsUrl,
    nameIdFormat: "email",
    accessTeams: [{ teamId: group.teamId, sentAs: groupSlug }],
    emailAttributeName: "email",
    nameAttributeName: "name",
    groupsAttributeName: "groups",
    signResponse: true,
    requireSignedAuthnRequests: false,
    spSigningCertificate: null,
    allowIdpInitiated: true,
    enabled: true,
  };

  const application = await successfulJson(
    await worker.fetch(
      new Request(`${origin}/api/admin/saml-applications`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(applicationInput),
      })
    ),
    applicationCreatedSchema
  );

  return {
    cookie,
    state,
    userId,
    email,
    groupSlug,
    entityId,
    acsUrl,
    applicationInput,
    application,
  };
}

describe("SAML identity provider", () => {
  it("signs with the self-signed certificate Alchemy minted (alchemy/keys.ts)", () => {
    const certificate = new X509Certificate(idpCertificate);
    // Named after the hostname the stack serves (testing/harness.ts).
    expect(certificate.subject).toBe("CN=example.test");
    expect(certificate.issuer).toBe(certificate.subject);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(certificate.ca).toBe(false);
    expect(certificate.publicKey.asymmetricKeyType).toBe("rsa");
    expect(certificate.publicKey.asymmetricKeyDetails?.modulusLength).toBe(
      2048
    );
    expect(
      certificate.validToDate.getTime() - certificate.validFromDate.getTime()
    ).toBeGreaterThan(3649 * 86_400_000);
    expect(certificate.validFromDate.getTime()).toBeLessThanOrEqual(Date.now());
  });

  let fixture!: Awaited<ReturnType<typeof samlFixture>>;

  beforeAll(async () => {
    fixture = await samlFixture("suite");
  });

  it("publishes metadata and issues signed SP- and IdP-initiated assertions", async () => {
    const {
      cookie,
      state,
      userId,
      email,
      groupSlug,
      entityId,
      acsUrl,
      application,
    } = fixture;

    expect(state.samlProvider).toMatchObject({
      configured: true,
      entityId: `${origin}/saml/metadata`,
    });

    const metadata = await worker.fetch(`${origin}/saml/metadata`);
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("content-type")).toContain(
      "application/samlmetadata+xml"
    );
    const metadataXml = await metadata.text();
    expect(metadataXml).toContain(`entityID="${origin}/saml/metadata"`);
    expect(metadataXml).toContain("X509Certificate");

    const adminState = await successfulJson(
      await worker.fetch(
        new Request(`${origin}/api/admin/state`, { headers: { cookie } })
      ),
      z.object({ samlApplications: z.array(z.looseObject({ id: z.string() })) })
    );

    const applicationSummary = adminState.samlApplications.find(
      (candidate) => candidate.id === application.applicationId
    );

    expect(applicationSummary).toBeTruthy();
    expect(applicationSummary).not.toHaveProperty("spSigningCertificate");
    expect(
      await successfulJson(
        await worker.fetch(
          new Request(
            `${origin}/api/admin/saml-applications/${application.applicationId}`,
            { headers: { cookie } }
          )
        ),
        z.object({ spSigningCertificate: z.string().nullable() })
      )
    ).toMatchObject({ spSigningCertificate: null });

    const requestId = "_request_123";
    const ssoUrl = new URL(`${origin}/saml/sso`);
    ssoUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({ id: requestId, issuer: entityId, acsUrl })
    );
    ssoUrl.searchParams.set("RelayState", "return-to-dashboard");

    const sso = await worker.fetch(
      new Request(ssoUrl, { headers: { cookie }, redirect: "manual" })
    );

    const html = await sso.text();
    expect(sso.status, html).toBe(200);
    expect(html).toContain(`action="${acsUrl}"`);
    expect(html).toContain('name="RelayState" value="return-to-dashboard"');
    const xml = samlResponseXml(html);
    expect(xml).toContain(`InResponseTo="${requestId}"`);
    expect(xml).toContain(`>${email}</saml:NameID>`);
    expect(xml).toContain(
      `<saml:AttributeValue>${groupSlug}</saml:AttributeValue>`
    );
    expectValidSignature(xml, "Response");
    expectValidSignature(xml, "Assertion");

    const signedOutRequestId = "_request_signed_out";
    const signedOutUrl = new URL(`${origin}/saml/sso`);
    signedOutUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({ id: signedOutRequestId, issuer: entityId, acsUrl })
    );

    const signedOut = await worker.fetch(
      new Request(signedOutUrl, { redirect: "manual" })
    );

    expect(signedOut.status).toBe(302);

    const { location: loginLocation, id: transactionId } =
      redirectId(signedOut);

    expect(loginLocation).toMatch(/^\/saml\/login\/samlreq_/u);

    const transactionCookie = responseCookie(
      signedOut,
      samlTransactionCookieName(transactionId)
    );

    expect(transactionCookie).toBeTruthy();
    const parallelUrl = new URL(`${origin}/saml/sso`);
    parallelUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({
        id: "_request_parallel_signed_out",
        issuer: entityId,
        acsUrl,
      })
    );

    const parallel = await worker.fetch(
      new Request(parallelUrl, { redirect: "manual" })
    );

    const { id: parallelTransactionId } = redirectId(parallel);

    const parallelTransactionCookie = responseCookie(
      parallel,
      samlTransactionCookieName(parallelTransactionId)
    );

    expect(parallelTransactionCookie).toBeTruthy();
    expect(parallelTransactionCookie).not.toBe(transactionCookie);
    const transactionCookies = `${transactionCookie}; ${parallelTransactionCookie}`;

    const loginPreview = await successfulJson(
      await worker.fetch(
        new Request(`${origin}/api/saml/login/${transactionId}`, {
          headers: { cookie: transactionCookies },
        })
      ),
      loginPreviewSchema
    );

    expect(loginPreview.transaction.applicationName).toBe("Example service");

    const parallelPreview = await successfulJson(
      await worker.fetch(
        new Request(`${origin}/api/saml/login/${parallelTransactionId}`, {
          headers: { cookie: transactionCookies },
        })
      ),
      loginPreviewSchema
    );

    expect(parallelPreview.transaction.applicationName).toBe("Example service");

    const login = await worker.fetch(
      new Request(`${origin}/api/auth/mock/login`, {
        method: "POST",
        headers: {
          cookie: transactionCookies,
          "content-type": "application/json",
        },
        body: JSON.stringify({ userId, samlRequestId: transactionId }),
      })
    );

    const completed = await successfulJson(
      login,
      z.object({ redirectTo: z.string() })
    );

    expect(completed.redirectTo).toBe(`/saml/resume/${transactionId}`);

    const resumedSession = required(
      responseCookie(login, "op_session_dev"),
      "the login set no session cookie"
    );

    const resumed = await worker.fetch(
      new Request(new URL(completed.redirectTo, origin), {
        headers: { cookie: resumedSession },
      })
    );

    expect(resumed.status).toBe(200);
    const resumedXml = samlResponseXml(await resumed.text());
    expect(resumedXml).toContain(`InResponseTo="${signedOutRequestId}"`);
    expectValidSignature(resumedXml, "Assertion");

    const replay = await worker.fetch(
      new Request(ssoUrl, { headers: { cookie }, redirect: "manual" })
    );

    expect(replay.status).toBe(409);
    expect(await replay.text()).toContain("already been used");

    const launch = await worker.fetch(
      new Request(`${origin}/saml/launch/${application.applicationId}`, {
        headers: { cookie },
      })
    );

    expect(launch.status).toBe(200);
    const launchXml = samlResponseXml(await launch.text());
    expect(launchXml).not.toContain("InResponseTo=");
    expectValidSignature(launchXml, "Response");
    expectValidSignature(launchXml, "Assertion");
  });

  it("handles requested authentication contexts and passive requests", async () => {
    const { cookie, entityId, acsUrl } = fixture;

    const unsupportedContextUrl = new URL(`${origin}/saml/sso`);
    unsupportedContextUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({
        id: "_unsupported_authn_context",
        issuer: entityId,
        acsUrl,
        requestedAuthnContext: {
          classRefs: [
            "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
          ],
        },
      })
    );
    unsupportedContextUrl.searchParams.set("RelayState", "unsupported-context");

    const unsupportedContext = await worker.fetch(
      new Request(unsupportedContextUrl, { headers: { cookie } })
    );

    expect(unsupportedContext.status).toBe(200);
    const unsupportedContextHtml = await unsupportedContext.text();
    expect(unsupportedContextHtml).toContain(`action="${acsUrl}"`);
    expect(unsupportedContextHtml).toContain(
      'name="RelayState" value="unsupported-context"'
    );
    const unsupportedContextXml = samlResponseXml(unsupportedContextHtml);
    expect(unsupportedContextXml).toContain(
      "urn:oasis:names:tc:SAML:2.0:status:Responder"
    );
    expect(unsupportedContextXml).toContain(
      "urn:oasis:names:tc:SAML:2.0:status:NoAuthnContext"
    );
    expect(unsupportedContextXml).not.toContain("<saml:Assertion");
    expectValidSignature(unsupportedContextXml, "Response");

    const supportedContextUrl = new URL(`${origin}/saml/sso`);
    supportedContextUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({
        id: "_supported_authn_context",
        issuer: entityId,
        acsUrl,
        requestedAuthnContext: {
          classRefs: [SAML_AUTHN_CONTEXT_UNSPECIFIED],
        },
      })
    );

    const supportedContext = await worker.fetch(
      new Request(supportedContextUrl, { headers: { cookie } })
    );

    expect(supportedContext.status).toBe(200);
    expect(samlResponseXml(await supportedContext.text())).toContain(
      `<saml:AuthnContextClassRef>${SAML_AUTHN_CONTEXT_UNSPECIFIED}</saml:AuthnContextClassRef>`
    );

    const passiveUrl = new URL(`${origin}/saml/sso`);
    passiveUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({
        id: "_passive_with_session",
        issuer: entityId,
        acsUrl,
        isPassive: true,
      })
    );

    const passive = await worker.fetch(
      new Request(passiveUrl, { headers: { cookie } })
    );

    expect(passive.status).toBe(200);
    const passiveXml = samlResponseXml(await passive.text());
    expect(passiveXml).toContain("urn:oasis:names:tc:SAML:2.0:status:Success");
    expectValidSignature(passiveXml, "Assertion");

    const passiveSignedOutUrl = new URL(`${origin}/saml/sso`);
    passiveSignedOutUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({
        id: "_passive_without_session",
        issuer: entityId,
        acsUrl,
        isPassive: true,
      })
    );
    const passiveSignedOut = await worker.fetch(passiveSignedOutUrl);
    expect(passiveSignedOut.status).toBe(200);
    const passiveSignedOutXml = samlResponseXml(await passiveSignedOut.text());
    expect(passiveSignedOutXml).toContain(
      "urn:oasis:names:tc:SAML:2.0:status:NoPassive"
    );
    expect(passiveSignedOutXml).not.toContain("<saml:Assertion");
    expectValidSignature(passiveSignedOutXml, "Response");
  });

  it("enforces application access and email NameID policies", async () => {
    const { cookie, entityId, acsUrl, applicationInput } = fixture;

    const qualifiedNameIdUrl = new URL(`${origin}/saml/sso`);
    qualifiedNameIdUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({
        id: "_matching_sp_qualifier",
        issuer: entityId,
        acsUrl,
        nameIdPolicy: {
          format: samlNameIdFormatUris.email,
          spNameQualifier: entityId,
        },
      })
    );

    const qualifiedNameId = await worker.fetch(
      new Request(qualifiedNameIdUrl, { headers: { cookie } })
    );

    expect(qualifiedNameId.status).toBe(200);
    expect(samlResponseXml(await qualifiedNameId.text())).toContain(
      `SPNameQualifier="${entityId}"`
    );

    const unsupportedQualifierUrl = new URL(`${origin}/saml/sso`);
    unsupportedQualifierUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({
        id: "_unsupported_sp_qualifier",
        issuer: entityId,
        acsUrl,
        nameIdPolicy: {
          format: samlNameIdFormatUris.email,
          spNameQualifier: "https://different.example.test/saml/metadata",
        },
      })
    );

    const unsupportedQualifier = await worker.fetch(
      new Request(unsupportedQualifierUrl, { headers: { cookie } })
    );

    expect(unsupportedQualifier.status).toBe(200);

    const unsupportedQualifierXml = samlResponseXml(
      await unsupportedQualifier.text()
    );

    expect(unsupportedQualifierXml).toContain(
      "urn:oasis:names:tc:SAML:2.0:status:InvalidNameIDPolicy"
    );
    expect(unsupportedQualifierXml).not.toContain("<saml:Assertion");
    expectValidSignature(unsupportedQualifierXml, "Response");

    const unassignedEntityId = "https://unassigned.example.test/saml/metadata";
    const unassignedAcsUrl = "https://unassigned.example.test/saml/acs";
    await successfulJson(
      await worker.fetch(
        new Request(`${origin}/api/admin/saml-applications`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            ...applicationInput,
            name: "Unassigned service",
            entityId: unassignedEntityId,
            acsUrl: unassignedAcsUrl,
            accessTeams: [],
          }),
        })
      ),
      z.unknown()
    );
    const unassignedUrl = new URL(`${origin}/saml/sso`);
    unassignedUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({
        id: "_unassigned_user",
        issuer: unassignedEntityId,
        acsUrl: unassignedAcsUrl,
      })
    );

    const unassigned = await worker.fetch(
      new Request(unassignedUrl, { headers: { cookie } })
    );

    expect(unassigned.status).toBe(200);
    const unassignedXml = samlResponseXml(await unassigned.text());
    expect(unassignedXml).toContain(
      "urn:oasis:names:tc:SAML:2.0:status:RequestDenied"
    );
    expect(unassignedXml).not.toContain("<saml:Assertion");
    expectValidSignature(unassignedXml, "Response");
  });

  it("issues stable persistent NameIDs and enforces AllowCreate", async () => {
    const { cookie, userId, applicationInput } = fixture;

    const persistentApplications = await Promise.all(
      ["one", "two", "three", "four"].map(async (suffix) =>
        successfulJson(
          await worker.fetch(
            new Request(`${origin}/api/admin/saml-applications`, {
              method: "POST",
              headers: { cookie, "content-type": "application/json" },
              body: JSON.stringify({
                ...applicationInput,
                name: `Persistent service ${suffix}`,
                entityId: `https://persistent-${suffix}.example.test/saml/metadata`,
                acsUrl: `https://persistent-${suffix}.example.test/saml/acs`,
                nameIdFormat: "persistent",
              }),
            })
          ),
          applicationCreatedSchema
        )
      )
    );

    const [appOne, appTwo, , appFour] = persistentApplications;
    const first = required(appOne, "persistent app one");
    const second = required(appTwo, "persistent app two");
    const fourth = required(appFour, "persistent app four");

    await successfulJson(
      await worker.fetch(
        new Request(
          `${origin}/api/admin/saml-applications/${fourth.applicationId}`,
          {
            method: "PATCH",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({
              ...applicationInput,
              name: "Persistent service four",
              entityId:
                "https://persistent-four-renamed.example.test/saml/metadata",
              acsUrl: "https://persistent-four-renamed.example.test/saml/acs",
              nameIdFormat: "persistent",
            }),
          }
        )
      ),
      z.unknown()
    );

    // Each app's first launch, which issues its NameID.
    const persistentNameIds = await Promise.all(
      [first, second].map(async ({ applicationId }) => {
        const persistentLaunch = await worker.fetch(
          new Request(`${origin}/saml/launch/${applicationId}`, {
            headers: { cookie },
          })
        );

        expect(persistentLaunch.status).toBe(200);

        return samlNameId(samlResponseXml(await persistentLaunch.text()));
      })
    );

    const repeatedLaunch = await worker.fetch(
      new Request(`${origin}/saml/launch/${first.applicationId}`, {
        headers: { cookie },
      })
    );

    expect(persistentNameIds[0]).toMatch(/^samlsub_[a-f0-9]{32}$/u);
    expect(persistentNameIds[0]).not.toBe(userId);
    expect(persistentNameIds[0]).not.toBe(persistentNameIds[1]);
    expect(samlNameId(samlResponseXml(await repeatedLaunch.text()))).toBe(
      persistentNameIds[0]
    );

    const entityIdChange = await worker.fetch(
      new Request(
        `${origin}/api/admin/saml-applications/${first.applicationId}`,
        {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            ...applicationInput,
            name: "Persistent service one",
            entityId:
              "https://persistent-one-renamed.example.test/saml/metadata",
            acsUrl: "https://persistent-one.example.test/saml/acs",
            nameIdFormat: "persistent",
          }),
        }
      )
    );

    expect(entityIdChange.status).toBe(409);
    expect(await entityIdChange.text()).toContain(
      "cannot change after a persistent NameID has been issued"
    );
    // The refused update left the app as it was.
    expect(
      await env.DB.prepare(
        "SELECT entity_id, acs_url FROM saml_applications WHERE id = ?"
      )
        .bind(first.applicationId)
        .first()
    ).toEqual({
      entity_id: "https://persistent-one.example.test/saml/metadata",
      acs_url: "https://persistent-one.example.test/saml/acs",
    });

    const persistentEntityId =
      "https://persistent-three.example.test/saml/metadata";

    const persistentAcsUrl = "https://persistent-three.example.test/saml/acs";

    function persistentSpRequest(requestId: string, allowCreate: boolean) {
      const url = new URL(`${origin}/saml/sso`);
      url.searchParams.set(
        "SAMLRequest",
        authnRequest({
          id: requestId,
          issuer: persistentEntityId,
          acsUrl: persistentAcsUrl,
          nameIdPolicy: {
            format: samlNameIdFormatUris.persistent,
            allowCreate,
          },
        })
      );

      return worker.fetch(new Request(url, { headers: { cookie } }));
    }

    const creationDenied = await persistentSpRequest(
      "_persistent_creation_denied",
      false
    );

    expect(creationDenied.status).toBe(200);
    const creationDeniedXml = samlResponseXml(await creationDenied.text());
    expect(creationDeniedXml).toContain(
      "urn:oasis:names:tc:SAML:2.0:status:InvalidNameIDPolicy"
    );
    expect(creationDeniedXml).not.toContain("<saml:Assertion");
    expectValidSignature(creationDeniedXml, "Response");

    const creationAllowed = await persistentSpRequest(
      "_persistent_creation_allowed",
      true
    );

    expect(creationAllowed.status).toBe(200);

    const createdNameId = samlNameId(
      samlResponseXml(await creationAllowed.text())
    );

    const existingAllowed = await persistentSpRequest(
      "_persistent_existing_allowed",
      false
    );

    expect(existingAllowed.status).toBe(200);
    expect(samlNameId(samlResponseXml(await existingAllowed.text()))).toBe(
      createdNameId
    );

    const unconstrainedUrl = new URL(`${origin}/saml/sso`);
    unconstrainedUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({
        id: "_persistent_without_name_id_policy",
        issuer: "https://persistent-four-renamed.example.test/saml/metadata",
        acsUrl: "https://persistent-four-renamed.example.test/saml/acs",
      })
    );

    const unconstrained = await worker.fetch(
      new Request(unconstrainedUrl, { headers: { cookie } })
    );

    expect(unconstrained.status).toBe(200);
    expect(samlNameId(samlResponseXml(await unconstrained.text()))).toMatch(
      /^samlsub_[a-f0-9]{32}$/u
    );
  });

  it("requires valid Redirect signatures when configured", async () => {
    const { cookie, applicationInput } = fixture;
    const entityId = "https://signed.service.example.test/saml/metadata";
    const acsUrl = "https://signed.service.example.test/saml/acs";
    await successfulJson(
      await worker.fetch(
        new Request(`${origin}/api/admin/saml-applications`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            ...applicationInput,
            name: "Signed request service",
            entityId,
            acsUrl,
            requireSignedAuthnRequests: true,
            spSigningCertificate: spCertificate,
          }),
        })
      ),
      z.unknown()
    );
    const unsignedUrl = new URL(`${origin}/saml/sso`);
    unsignedUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({ id: "_unsigned_request", issuer: entityId, acsUrl })
    );

    const unsigned = await worker.fetch(
      new Request(unsignedUrl, { headers: { cookie } })
    );

    expect(unsigned.status).toBe(400);

    const signedParameters = new URLSearchParams();
    signedParameters.set(
      "SAMLRequest",
      authnRequest({ id: "_signed_request", issuer: entityId, acsUrl })
    );
    signedParameters.set(
      "SigAlg",
      "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"
    );

    const signature = sign(
      "RSA-SHA256",
      Buffer.from(signedParameters.toString()),
      spPrivateKey
    ).toString("base64");

    signedParameters.set("Signature", signature);

    const signed = await worker.fetch(
      new Request(`${origin}/saml/sso?${signedParameters}`, {
        headers: { cookie },
      })
    );

    expect(signed.status, await signed.clone().text()).toBe(200);
    expectValidSignature(samlResponseXml(await signed.text()), "Assertion");

    const missingDestinationParameters = new URLSearchParams();
    missingDestinationParameters.set(
      "SAMLRequest",
      authnRequest({
        id: "_signed_without_destination",
        issuer: entityId,
        acsUrl,
        destination: null,
      })
    );
    missingDestinationParameters.set(
      "SigAlg",
      "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"
    );
    missingDestinationParameters.set(
      "Signature",
      sign(
        "RSA-SHA256",
        Buffer.from(missingDestinationParameters.toString()),
        spPrivateKey
      ).toString("base64")
    );

    const missingDestination = await worker.fetch(
      new Request(`${origin}/saml/sso?${missingDestinationParameters}`, {
        headers: { cookie },
      })
    );

    expect(missingDestination.status).toBe(400);
    expect(await missingDestination.text()).toContain(
      "must include Destination"
    );
  });

  it("rejects XML-invalid RelayState from service providers", async () => {
    const { cookie, entityId, acsUrl } = fixture;
    const spInitiated = new URL(`${origin}/saml/sso`);
    spInitiated.searchParams.set(
      "SAMLRequest",
      authnRequest({ id: "_invalid_relay_state", issuer: entityId, acsUrl })
    );
    spInitiated.searchParams.set("RelayState", "before\0after");

    const spResponse = await worker.fetch(
      new Request(spInitiated, { headers: { cookie } })
    );

    expect(spResponse.status).toBe(400);
    expect(await spResponse.text()).toContain("RelayState is invalid");
  });

  it("ignores RelayState on an IdP-initiated launch link", async () => {
    const { cookie, application } = fixture;

    // Whoever crafts a launch link must not choose where the app lands the person.
    const launch = await worker.fetch(
      new Request(
        `${origin}/saml/launch/${application.applicationId}?RelayState=${encodeURIComponent("https://evil.example/phish")}`,
        { headers: { cookie } }
      )
    );

    expect(launch.status).toBe(200);
    const page = await launch.text();
    expect(page).not.toContain("RelayState");
    expect(page).not.toContain("evil.example");

    // An invalid one changes nothing either.
    const invalid = await worker.fetch(
      new Request(
        `${origin}/saml/launch/${application.applicationId}?RelayState=before%00after`,
        { headers: { cookie } }
      )
    );

    expect(invalid.status).toBe(200);
    await invalid.body?.cancel();
  });

  it("maps an invalid mock SAML continuation to a client error", async () => {
    const response = await worker.fetch(
      new Request(`${origin}/api/auth/mock/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "usr_missing",
          samlRequestId: "samlreq_missing",
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: {
        code: "WEBAUTHN_FAILED",
        message: "SAML login transaction is not bound to this browser",
      },
    });
  });

  it("returns HTTP 429 when the SAML rate limit is exceeded", async () => {
    let response: Response | undefined;

    for (let attempt = 0; attempt <= 60; attempt += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one request after another until the limit trips
      response = await worker.fetch(
        new Request(`${origin}/saml/sso`, {
          headers: { "cf-connecting-ip": "203.0.113.250" },
        })
      );

      if (response.status === 429) break;
    }

    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBeTruthy();
  });
});
