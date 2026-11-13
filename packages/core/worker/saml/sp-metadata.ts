import { X509Certificate } from "node:crypto";

import { required } from "../../shared/invariant";
import {
  SAML_BINDINGS,
  SAML_NAMESPACES,
  samlNameIdFormats,
  samlNameIdFormatUris,
} from "../../shared/saml";
import type { SamlNameIdFormat } from "../../shared/saml";
import { isSamlEntityId } from "../admin/schemas";
import { readBounded } from "../lib/stream";
import { isAllowedOidcRedirectUri } from "../oidc/validation";
import { SP_METADATA_MAX_BYTES } from "./constants";
import { isSupportedSamlRsaKey } from "./credentials";
import { SamlError } from "./errors";
import { childElements, parseXmlDocument } from "./xml";
import type { XmlElement } from "./xml";
import { isValidXmlCharacters } from "./xml-text";

const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const METADATA_UI_NAMESPACE = "urn:oasis:names:tc:SAML:metadata:ui";

/** What a service provider's metadata says, ready to fill the admin form. */
export type SpMetadataDraft = {
  name: string | null;
  entityId: string;
  acsUrl: string;
  nameIdFormat: SamlNameIdFormat | null;
  requireSignedAuthnRequests: boolean;
  spSigningCertificate: string | null;
  /** Things the admin should know, such as a certificate that was left out. */
  warnings: string[];
};

type Ipv4Octets = [number, number, number, number];

function ipv4Octets(hostname: string): Ipv4Octets | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);

  if (!match) return null;

  const octets: Ipv4Octets = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
  ];

  return octets.every((octet) => octet <= 255) ? octets : null;
}

function isPublicIpv4([a, b]: Ipv4Octets) {
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * Whether the Worker may fetch from this host: a public DNS name or a public
 * IP address, never loopback, link-local, private, or local-only names.
 * Names are not resolved, so this stops the obvious cases; Cloudflare does
 * not route Worker subrequests into private networks anyway.
 */
export function isPublicFetchHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/u, "");

  if (host.startsWith("[")) {
    const address = host.slice(1, -1);

    // Only global unicast (2000::/3), never IPv4-mapped or local ranges.
    return /^[23][0-9a-f]{0,3}:/u.test(address) && !address.includes(".");
  }

  const octets = ipv4Octets(host);

  if (octets) return isPublicIpv4(octets);

  if (!host.includes(".")) return false;

  return ![
    "localhost",
    "local",
    "internal",
    "home.arpa",
    "lan",
    "intranet",
  ].some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function fetchableUrl(value: string) {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new SamlError("Enter the metadata address as a full https:// URL");
  }

  if (url.protocol !== "https:") {
    throw new SamlError("The metadata address must use https://");
  }

  if (url.username || url.password) {
    throw new SamlError(
      "The metadata address must not contain a user name or password"
    );
  }

  if ((url.port && url.port !== "443") || !isPublicFetchHost(url.hostname)) {
    throw new SamlError("The metadata address must be on the public internet");
  }

  return url;
}

async function readLimited(response: Response) {
  const declared = Number(response.headers.get("content-length") ?? 0);

  if (declared > SP_METADATA_MAX_BYTES || !response.body) {
    await response.body?.cancel();

    if (!response.body) {
      throw new SamlError("The metadata address returned nothing");
    }

    throw new SamlError("The metadata file is larger than 512 KB");
  }

  const { bytes, complete } = await readBounded(
    response.body,
    SP_METADATA_MAX_BYTES
  );

  if (!complete) {
    throw new SamlError("The metadata file is larger than 512 KB");
  }

  return new TextDecoder().decode(bytes);
}

/** Fetches `url`, then each redirect in turn while `redirectsLeft` lasts. */
async function fetchFollowingRedirects(
  url: URL,
  deadline: AbortSignal,
  redirectsLeft: number
): Promise<string> {
  let response: Response;

  try {
    response = await fetch(url, {
      headers: {
        accept: "application/samlmetadata+xml, application/xml, text/xml",
      },
      redirect: "manual",
      signal: deadline,
    });
  } catch {
    throw new SamlError("The metadata address could not be reached in time");
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    const location = response.headers.get("location");

    if (!location) {
      throw new SamlError("The metadata address redirected nowhere");
    }

    if (redirectsLeft === 0) {
      throw new SamlError("The metadata address redirected too many times");
    }

    return fetchFollowingRedirects(
      fetchableUrl(new URL(location, url).toString()),
      deadline,
      redirectsLeft - 1
    );
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new SamlError(`The metadata address answered ${response.status}`);
  }

  return readLimited(response);
}

/** Downloads metadata from a public HTTPS address, re-checking every redirect. */
export function fetchSpMetadata(address: string) {
  return fetchFollowingRedirects(
    fetchableUrl(address),
    AbortSignal.timeout(FETCH_TIMEOUT_MS),
    MAX_REDIRECTS
  );
}

function children(element: XmlElement, namespace: string, localName: string) {
  return childElements(element).filter(
    (child) => child.namespaceURI === namespace && child.localName === localName
  );
}

function descendants(
  element: XmlElement,
  namespace: string,
  localName: string
) {
  return Array.from(element.getElementsByTagNameNS(namespace, localName));
}

function text(element: XmlElement | undefined) {
  return element?.textContent?.trim() || null;
}

function serviceProviderEntity(root: XmlElement) {
  const entities =
    root.localName === "EntityDescriptor"
      ? [root]
      : descendants(root, SAML_NAMESPACES.metadata, "EntityDescriptor");

  const entity = entities.find(
    (item) =>
      children(item, SAML_NAMESPACES.metadata, "SPSSODescriptor").length > 0
  );

  if (!entity) {
    throw new SamlError(
      "This metadata does not describe a SAML service provider"
    );
  }

  return entity;
}

function pickAssertionConsumer(descriptor: XmlElement) {
  const services = children(
    descriptor,
    SAML_NAMESPACES.metadata,
    "AssertionConsumerService"
  ).filter((service) => service.getAttribute("Binding") === SAML_BINDINGS.post);

  const explicitDefault = services.find(
    (service) => service.getAttribute("isDefault") === "true"
  );

  if (explicitDefault) return explicitDefault;

  return services
    .map((service, order) => ({
      service,
      index: Number(service.getAttribute("index") ?? order),
    }))
    .sort((left, right) => left.index - right.index)[0]?.service;
}

function nameIdFormat(descriptor: XmlElement): SamlNameIdFormat | null {
  const formats = children(
    descriptor,
    SAML_NAMESPACES.metadata,
    "NameIDFormat"
  ).map((element) => text(element));

  // The first format the app lists that this identity provider can send.
  for (const format of formats) {
    const known = samlNameIdFormats.find(
      (candidate) => samlNameIdFormatUris[candidate] === format
    );

    if (known) return known;
  }

  return null;
}

function signingCertificate(descriptor: XmlElement) {
  const keys = children(
    descriptor,
    SAML_NAMESPACES.metadata,
    "KeyDescriptor"
  ).filter((key) => (key.getAttribute("use") ?? "signing") === "signing");

  for (const key of keys) {
    const body = text(
      descendants(key, SAML_NAMESPACES.signature, "X509Certificate")[0]
    )?.replaceAll(/\s+/gu, "");

    if (!body) continue;
    const pem = `-----BEGIN CERTIFICATE-----\n${(body.match(/.{1,64}/gu) ?? []).join("\n")}\n-----END CERTIFICATE-----\n`;

    try {
      const certificate = new X509Certificate(pem);

      if (isSupportedSamlRsaKey(certificate.publicKey)) {
        return { pem: certificate.toString() };
      }

      return {
        error:
          "The app's signing certificate is not an RSA key of 2048 bits or more",
      };
    } catch {
      return { error: "The app's signing certificate could not be read" };
    }
  }

  return null;
}

function displayName(entity: XmlElement) {
  const name =
    text(descendants(entity, METADATA_UI_NAMESPACE, "DisplayName")[0]) ??
    text(
      descendants(
        entity,
        SAML_NAMESPACES.metadata,
        "OrganizationDisplayName"
      )[0]
    );

  return name && isValidXmlCharacters(name) ? name.slice(0, 80) : null;
}

/** Reads a service provider's SAML metadata into form values. */
export function parseSpMetadata(xml: string): SpMetadataDraft {
  if (new TextEncoder().encode(xml).byteLength > SP_METADATA_MAX_BYTES) {
    throw new SamlError("The metadata file is larger than 512 KB");
  }

  const document = parseXmlDocument(
    xml.replace(/^\uFEFF/u, ""),
    "The metadata"
  );

  const root = document.documentElement;

  if (
    !root ||
    root.namespaceURI !== SAML_NAMESPACES.metadata ||
    !["EntityDescriptor", "EntitiesDescriptor"].includes(root.localName ?? "")
  ) {
    throw new SamlError("This is not a SAML metadata file");
  }

  const entity = serviceProviderEntity(root);

  // serviceProviderEntity picked an entity with one.
  const descriptor = required(
    children(entity, SAML_NAMESPACES.metadata, "SPSSODescriptor")[0],
    "The service provider entity has an SPSSODescriptor"
  );

  const entityId = entity.getAttribute("entityID")?.trim() ?? "";

  if (!isSamlEntityId(entityId)) {
    throw new SamlError("The metadata has no usable entityID");
  }

  const acsUrl =
    pickAssertionConsumer(descriptor)?.getAttribute("Location")?.trim() ?? "";

  if (!acsUrl) {
    throw new SamlError(
      "The metadata lists no HTTP-POST Assertion Consumer Service"
    );
  }

  if (!isAllowedOidcRedirectUri(acsUrl) || !isValidXmlCharacters(acsUrl)) {
    throw new SamlError("The app's sign-in reply URL must use HTTPS");
  }

  const warnings: string[] = [];
  const format = nameIdFormat(descriptor);

  if (!format) {
    warnings.push(
      "The app did not ask for an email or persistent NameID; email is used."
    );
  }

  const certificate = signingCertificate(descriptor);

  const signsRequests =
    descriptor.getAttribute("AuthnRequestsSigned") === "true";

  if (certificate?.error) warnings.push(certificate.error);
  const pem = certificate?.pem ?? null;

  if (signsRequests && !pem) {
    warnings.push(
      "The app signs its requests but its certificate is missing, so signature checks stay off."
    );
  }

  return {
    name: displayName(entity),
    entityId,
    acsUrl,
    nameIdFormat: format,
    requireSignedAuthnRequests: signsRequests && Boolean(pem),
    spSigningCertificate: pem,
    warnings,
  };
}
