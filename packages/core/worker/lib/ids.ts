import { normalizeExternalEmailAddress } from "../../shared/email-address";

export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Preserve the RFC local part used for transport while canonicalizing the
 * case-insensitive domain. Provider-specific local-part rules do not belong
 * here because they can change the destination of an external message.
 */
export function normalizeEmail(value: string): string {
  return normalizeExternalEmailAddress(value);
}

/**
 * Addresses provisioned for this account use one explicit,
 * case-insensitive mailbox namespace. Keep this policy separate from external
 * transport normalization.
 */
export function normalizeMailboxAddress(value: string): string {
  return normalizeEmail(value).toLocaleLowerCase("en-US");
}

export function emailDomain(value: string): string {
  return normalizeEmail(value).split("@").at(-1) ?? "";
}

export function mailboxAddressParts(value: string) {
  const normalized = normalizeMailboxAddress(value);
  const separator = normalized.lastIndexOf("@");

  return {
    localPart: normalized.slice(0, separator),
    domain: normalized.slice(separator + 1),
  };
}
