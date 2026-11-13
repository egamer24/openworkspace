/**
 * Per-mailbox sender decisions (block, trust, reports) and unsubscribe
 * records, as returned with every incoming message.
 */

/** What a person said about a sender: "Report spam" or "Not spam". */
export type FeedbackLabel = "spam" | "not_spam";

export type SenderBlock = {
  /** The stored pattern: an address, or `@domain` for the whole domain. */
  pattern: string;
  scope: "address" | "domain";
  /** Workspace-wide blocks are set by an administrator. */
  workspace: boolean;
  at: number;
};

export type SenderStatus = {
  block: SenderBlock | null;
  trustedAt: number | null;
  reportedAt: number | null;
};

export type UnsubscribeMethod = "one_click" | "mailto" | "link";

export type UnsubscribeStatus =
  /** The sender's server accepted the one-click request. */
  | "done"
  /** An unsubscribe email was sent; the list processes it on its own schedule. */
  | "requested"
  /** The person opened the sender's unsubscribe page. */
  | "opened"
  | "failed";

export type Unsubscription = {
  listKey: string;
  method: UnsubscribeMethod;
  status: UnsubscribeStatus;
  /** Host of the https endpoint or the mailto address. */
  target: string | null;
  at: number;
};

const DOMAIN_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/u;

/**
 * Normalizes a block entry: `alex@x.com` stays an address, `x.com` and
 * `@x.com` become `@x.com` (the domain and its subdomains). Null if invalid.
 */
export function normalizeBlockPattern(value: string) {
  const input = value.trim().toLocaleLowerCase();

  if (input.length > 320) return null;
  const at = input.lastIndexOf("@");

  if (at > 0) {
    const domain = input.slice(at + 1);

    return DOMAIN_PATTERN.test(domain) && !/[\s<>,;"]/u.test(input.slice(0, at))
      ? input
      : null;
  }

  const domain = at === 0 ? input.slice(1) : input;

  return DOMAIN_PATTERN.test(domain) ? `@${domain}` : null;
}

/** The block entries that cover an address: the address itself and each parent domain. */
export function blockPatternsFor(address: string) {
  const value = address.trim().toLocaleLowerCase();
  const at = value.lastIndexOf("@");

  if (at <= 0) return [];
  const labels = value.slice(at + 1).split(".");

  const domains = labels
    .slice(0, -1)
    .map((_, index) => `@${labels.slice(index).join(".")}`);

  return [value, ...domains];
}
