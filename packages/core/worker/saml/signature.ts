import { SignedXml } from "xml-crypto";

import type { SamlConfiguration } from "./configuration";

const EXCLUSIVE_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";

const ENVELOPED_SIGNATURE =
  "http://www.w3.org/2000/09/xmldsig#enveloped-signature";

const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const SHA256_DIGEST = "http://www.w3.org/2001/04/xmlenc#sha256";

export function signSamlElement(
  xml: string,
  input: {
    localName: "Assertion" | "Response";
    id: string;
    configuration: SamlConfiguration;
  }
) {
  const element = `//*[local-name(.)='${input.localName}' and @ID='${input.id}']`;
  const issuer = `${element}/*[local-name(.)='Issuer']`;

  const signer = new SignedXml({
    privateKey: input.configuration.privateKeyPem,
    publicCert: input.configuration.certificatePem,
    canonicalizationAlgorithm: EXCLUSIVE_C14N,
    signatureAlgorithm: RSA_SHA256,
  });

  signer.addReference({
    xpath: element,
    transforms: [ENVELOPED_SIGNATURE, EXCLUSIVE_C14N],
    digestAlgorithm: SHA256_DIGEST,
  });
  signer.computeSignature(xml, {
    prefix: "ds",
    location: { reference: issuer, action: "after" },
  });

  return signer.getSignedXml();
}
