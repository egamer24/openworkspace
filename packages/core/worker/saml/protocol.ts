/**
 * The SAML protocol code the /saml routes load on first use: XML parsing
 * (@xmldom/xmldom) and signing (xml-crypto) are large and most requests to
 * a workspace never need them.
 */
export {
  parseRedirectAuthnRequest,
  parseRelayState,
  validateAuthnRequestForApplication,
  verifyRedirectAuthnRequest,
} from "./request";

export {
  assertUserCanUseSamlApplication,
  findSamlApplicationByEntityId,
  findSamlApplicationById,
  issueSamlTransaction,
} from "./service";

export { buildSamlErrorResponse, samlPostResponse } from "./response";
