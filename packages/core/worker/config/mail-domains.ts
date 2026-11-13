import { notInArray } from "drizzle-orm";

import { required } from "../../shared/invariant";
import { workspaceDomainRefusal } from "../../shared/workspace-domains";
import { createDb } from "../db/client";
import { mailboxes } from "../db/schema";
import { emailDomain } from "../lib/ids";
import { workspaceConfig } from "./index";

/**
 * Mail domains listed in alchemy.run.ts (`mailDomains`), primary first;
 * there is always at least one. The config is the only list: mailboxes keep
 * their domain as text and nothing copies the list into D1.
 */
export function configuredMailDomains() {
  return workspaceConfig().mailDomains;
}

/** The primary mail domain: the first one listed in `mailDomains`. */
export function primaryMailDomain() {
  return required(
    configuredMailDomains()[0],
    "The config schema lists at least one mail domain"
  );
}

/**
 * Whether a new or changed address may use this address's domain. Every
 * place that creates or renames an address asks this first, so no address
 * lands on a domain the config does not list.
 */
export function mailDomainAllowed(address: string) {
  return configuredMailDomains().includes(emailDomain(address));
}

/** Why an address was refused, naming the mail domains it may use. */
export function mailDomainRefusal() {
  return workspaceDomainRefusal(configuredMailDomains());
}

/**
 * Domains of existing mailboxes that `mailDomains` no longer lists, sorted.
 * Those addresses stay: they still receive, send, open, share, change, and
 * can be deleted, but no new address can be created on such a domain.
 */
export async function unlistedMailboxDomains(binding: D1Database) {
  const rows = await createDb(binding)
    .selectDistinct({ domain: mailboxes.domain })
    .from(mailboxes)
    .where(notInArray(mailboxes.domain, configuredMailDomains()))
    .orderBy(mailboxes.domain);

  return rows.map((row) => row.domain);
}

let checked: Promise<void> | null = null;

/**
 * Logs an error once per isolate when mailboxes sit on a domain that
 * `mailDomains` dropped. The deploy cannot catch this itself (Alchemy does
 * not read D1), so the Worker says so in its logs and the admin screen
 * lists the domains. A failed check is retried by the next request.
 */
export function reportUnlistedMailboxDomains(binding: D1Database) {
  checked ??= unlistedMailboxDomains(binding).then(
    (unlisted) => {
      if (unlisted.length === 0) return;

      console.error(
        `Mailboxes exist on mail domains that alchemy.run.ts no longer lists in mailDomains: ${unlisted.join(", ")}. ` +
          "They keep working, but no new address can be created there. " +
          "Add the domains back to mailDomains, or give those people and teams addresses on a listed domain and delete the old ones."
      );
    },
    (cause: unknown) => {
      checked = null;
      console.error(
        "Could not check mailbox domains against mailDomains",
        cause
      );
    }
  );

  return checked;
}
