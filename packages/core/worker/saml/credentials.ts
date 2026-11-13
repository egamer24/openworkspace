import type { KeyObject } from "node:crypto";

const MINIMUM_RSA_MODULUS_BITS = 2048;

export function isSupportedSamlRsaKey(key: KeyObject) {
  return (
    key.asymmetricKeyType === "rsa" &&
    (key.asymmetricKeyDetails?.modulusLength ?? 0) >= MINIMUM_RSA_MODULUS_BITS
  );
}
