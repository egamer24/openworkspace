import { getDomain } from "tldts";

import { addressDomain } from "../../shared/mail-headers";

/** Organizational domain (Public Suffix List registrable domain) of a host or address. */
export function organizationalDomain(value: string | null | undefined) {
  const domain = addressDomain(value);

  if (!domain) return null;

  return getDomain(domain) ?? domain;
}

/** DMARC relaxed alignment: both sides share one organizational domain. */
export function relaxedAligned(
  left: string | null | undefined,
  right: string | null | undefined
) {
  const a = organizationalDomain(left);

  return Boolean(a) && a === organizationalDomain(right);
}
