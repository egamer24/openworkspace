export const samlNameIdFormats = ["email", "persistent"] as const;

export type SamlNameIdFormat = (typeof samlNameIdFormats)[number];

export const samlNameIdFormatUris: Record<SamlNameIdFormat, string> = {
  email: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  persistent: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
};

export const SAML_BINDINGS = {
  redirect: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
  post: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
} as const;

export const SAML_NAMESPACES = {
  assertion: "urn:oasis:names:tc:SAML:2.0:assertion",
  metadata: "urn:oasis:names:tc:SAML:2.0:metadata",
  protocol: "urn:oasis:names:tc:SAML:2.0:protocol",
  signature: "http://www.w3.org/2000/09/xmldsig#",
} as const;

export const SAML_AUTHN_CONTEXT_UNSPECIFIED =
  "urn:oasis:names:tc:SAML:2.0:ac:classes:unspecified";
