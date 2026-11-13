import { workspaceDomainRefusal } from "../../shared/workspace-domains";

/**
 * What an address field on the workspace's mail domains holds: the local part the
 * person typed, the domain picked beside it, and, after a full address on an
 * unlisted domain was pasted or typed, that domain.
 */
export type DomainAddressState = {
  text: string;
  domain: string;
  rejectedDomain: string | null;
};

/** Splits typed or pasted text at its first "@": the local part, and the domain after it (null without one). */
export function splitAddressText(value: string) {
  const trimmed = value.trim();
  const separator = trimmed.indexOf("@");

  if (separator === -1) return { localPart: trimmed, domain: null };

  return {
    localPart: trimmed.slice(0, separator).trim(),
    domain: trimmed
      .slice(separator + 1)
      .trim()
      .toLowerCase(),
  };
}

/**
 * Folds a full address into the field: the local part stays in the text and
 * a listed domain becomes the picked one; an unlisted domain is remembered,
 * so the field can say which domains to use.
 */
export function settleAddressText(
  state: DomainAddressState,
  value: string,
  domains: readonly string[]
): DomainAddressState {
  const { localPart, domain } = splitAddressText(value);

  if (domain === null) return { ...state, text: value, rejectedDomain: null };

  if (domain === "") return { ...state, text: localPart, rejectedDomain: null };

  if (domains.includes(domain)) {
    return { text: localPart, domain, rejectedDomain: null };
  }

  return { ...state, text: localPart, rejectedDomain: domain };
}

/**
 * Whether typed text names a listed domain that no other listed domain
 * continues, so it can settle while the person types (example.co would
 * still be on its way to example.com).
 */
export function completesListedDomain(
  value: string,
  domains: readonly string[]
) {
  const { domain } = splitAddressText(value);

  if (!domain) return false;

  return (
    domains.includes(domain) &&
    !domains.some((other) => other !== domain && other.startsWith(domain))
  );
}

/** The full address the field holds, or why it can't be used. */
export function resolveDomainAddress(
  state: DomainAddressState,
  domains: readonly string[]
) {
  const { localPart, domain: typedDomain } = splitAddressText(state.text);
  const domain = typedDomain || state.domain;
  const unlisted = state.rejectedDomain !== null || !domains.includes(domain);

  return {
    address: localPart && !unlisted ? `${localPart}@${domain}` : null,
    /** Shown under the field once a full address on another domain was settled. */
    error:
      state.rejectedDomain === null
        ? null
        : `${state.rejectedDomain} isn't a workspace mail domain. ${workspaceDomainRefusal(domains)}.`,
    /** Blocks the form while the text names another domain, even mid-typing. */
    validity: unlisted ? workspaceDomainRefusal(domains) : "",
  };
}
