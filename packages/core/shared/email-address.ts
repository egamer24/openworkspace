const EMAIL_LOCAL_PART = /^[A-Za-z0-9_+'-]+(?:\.[A-Za-z0-9_+'-]+)*$/u;
const EMAIL_DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const EMAIL_TOP_LEVEL_DOMAIN = /^[A-Za-z]{2,63}$/u;

/**
 * Preserve the transport-significant local part while canonicalizing the
 * case-insensitive domain.
 */
export function normalizeExternalEmailAddress(value: string) {
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf("@");

  if (separator <= 0 || separator === trimmed.length - 1) return trimmed;

  return `${trimmed.slice(0, separator)}@${trimmed.slice(separator + 1).toLocaleLowerCase("en-US")}`;
}

export function isValidExternalEmailAddress(value: string) {
  if (value.length > 254) return false;
  const separator = value.lastIndexOf("@");

  if (separator <= 0 || separator !== value.indexOf("@")) return false;
  const localPart = value.slice(0, separator);
  const domain = value.slice(separator + 1);

  if (
    localPart.length > 64 ||
    domain.length > 253 ||
    !EMAIL_LOCAL_PART.test(localPart)
  ) {
    return false;
  }

  const labels = domain.split(".");
  const topLevelDomain = labels.at(-1);

  return (
    labels.length >= 2 &&
    topLevelDomain !== undefined &&
    labels.every((label) => EMAIL_DOMAIN_LABEL.test(label)) &&
    EMAIL_TOP_LEVEL_DOMAIN.test(topLevelDomain)
  );
}
