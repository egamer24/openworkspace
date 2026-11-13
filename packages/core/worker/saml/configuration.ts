import {
  createPrivateKey,
  createPublicKey,
  X509Certificate,
} from "node:crypto";

import type { AppEnv } from "../env";
import {
  identityProviderOrigin,
  IdentityProviderOriginError,
} from "../lib/identity-provider-origin";
import { SAML_PATHS } from "./constants";
import { isSupportedSamlRsaKey } from "./credentials";
import { SamlError } from "./errors";

export type SamlConfiguration = {
  origin: string;
  entityId: string;
  metadataUrl: string;
  ssoUrl: string;
  certificatePem: string;
  certificateBody: string;
  privateKeyPem: string;
};

let cached:
  | {
      originSource: string;
      privateKeySource: string;
      certificateSource: string;
      certificateValidFrom: number;
      certificateValidTo: number;
      configuration: SamlConfiguration;
    }
  | undefined;

export function samlPublicUrls(
  env: Pick<AppEnv["Bindings"], "IDENTITY_PROVIDER_ORIGIN" | "ALLOW_MOCK_AUTH">
) {
  try {
    const origin = identityProviderOrigin(env);

    return {
      origin,
      entityId: new URL(SAML_PATHS.metadata, origin).toString(),
      metadataUrl: new URL(SAML_PATHS.metadata, origin).toString(),
      ssoUrl: new URL(SAML_PATHS.sso, origin).toString(),
    };
  } catch (error) {
    if (!(error instanceof IdentityProviderOriginError)) throw error;
    throw new SamlError(error.message, 500);
  }
}

function validatedCertificate(source: string) {
  const certificate = new X509Certificate(source);

  if (!isSupportedSamlRsaKey(certificate.publicKey)) {
    throw new Error(
      "SAML signing certificates must use RSA keys of at least 2048 bits"
    );
  }

  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);

  return {
    certificate,
    body: certificate.raw.toString("base64"),
    validFrom,
    validTo,
  };
}

export function samlConfiguration(env: AppEnv["Bindings"]): SamlConfiguration {
  const originSource = env.IDENTITY_PROVIDER_ORIGIN.trim();
  const privateKeySource = env.SAML_SIGNING_PRIVATE_KEY?.trim() ?? "";
  const certificateSource = env.SAML_SIGNING_CERTIFICATE?.trim() ?? "";
  const now = Date.now();

  if (
    cached?.originSource === originSource &&
    cached.privateKeySource === privateKeySource &&
    cached.certificateSource === certificateSource &&
    cached.certificateValidFrom <= now &&
    cached.certificateValidTo > now
  ) {
    return cached.configuration;
  }

  if (!privateKeySource || !certificateSource) {
    throw new SamlError(
      "SAML signing key and certificate are not configured",
      503
    );
  }

  let certificateValidFrom: number;
  let certificateValidTo: number;
  let certificateBody: string;

  try {
    const privateKey = createPrivateKey(privateKeySource);
    const current = validatedCertificate(certificateSource);
    const { certificate } = current;

    if (!isSupportedSamlRsaKey(privateKey)) {
      throw new Error(
        "SAML signing credentials must use RSA keys of at least 2048 bits"
      );
    }

    const privatePublic = createPublicKey(privateKey).export({
      format: "der",
      type: "spki",
    });

    const certificatePublic = certificate.publicKey.export({
      format: "der",
      type: "spki",
    });

    if (!privatePublic.equals(certificatePublic)) {
      throw new Error("Certificate does not match the private key");
    }

    if (current.validFrom > now || current.validTo <= now) {
      throw new Error("SAML signing certificate must be currently valid");
    }

    certificateValidFrom = current.validFrom;
    certificateValidTo = current.validTo;
    certificateBody = current.body;
  } catch {
    throw new SamlError("SAML signing key or certificate is invalid", 500);
  }

  const urls = samlPublicUrls(env);

  const configuration = {
    ...urls,
    privateKeyPem: privateKeySource,
    certificatePem: certificateSource,
    certificateBody,
  };

  cached = {
    originSource,
    privateKeySource,
    certificateSource,
    certificateValidFrom,
    certificateValidTo,
    configuration,
  };

  return configuration;
}
