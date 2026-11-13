import {
  samlNameIdFormatUris,
  SAML_BINDINGS,
  SAML_NAMESPACES,
} from "../../shared/saml";
import type { SamlConfiguration } from "./configuration";
import { escapeXml } from "./xml-text";

export function samlMetadata(configuration: SamlConfiguration) {
  const entityId = escapeXml(configuration.entityId);
  const ssoUrl = escapeXml(configuration.ssoUrl);

  const signingKey =
    `<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="${SAML_NAMESPACES.signature}">` +
    `<ds:X509Data><ds:X509Certificate>${configuration.certificateBody}</ds:X509Certificate></ds:X509Data>` +
    `</ds:KeyInfo></md:KeyDescriptor>`;

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<md:EntityDescriptor xmlns:md="${SAML_NAMESPACES.metadata}" entityID="${entityId}">` +
    `<md:IDPSSODescriptor protocolSupportEnumeration="${SAML_NAMESPACES.protocol}">${
      signingKey
    }<md:NameIDFormat>${samlNameIdFormatUris.email}</md:NameIDFormat>` +
    `<md:NameIDFormat>${samlNameIdFormatUris.persistent}</md:NameIDFormat>` +
    `<md:SingleSignOnService Binding="${SAML_BINDINGS.redirect}" Location="${ssoUrl}"/>` +
    `</md:IDPSSODescriptor></md:EntityDescriptor>`
  );
}
