import {
  configuredMailDomains,
  createDb,
  mailboxes,
  users,
} from "@open-workspace/core/module";
import { inArray, isNotNull } from "drizzle-orm";

import { protectedNames } from "./impersonation";
import { isolateCache, WORKSPACE_CACHE_TTL_MS } from "./isolate-cache";
import { DQS_KEY_PATTERN } from "./spamhaus";

/** Workspace-wide inputs for sender checks, read from D1 once per request or delivery. */
export type WorkspaceIdentity = {
  domains: string[];
  /** Normalized internal person name → display form. */
  names: Map<string, string>;
};

export async function workspaceIdentity(
  binding: D1Database
): Promise<WorkspaceIdentity> {
  const db = createDb(binding);

  const [userRows, mailboxRows] = await db.batch([
    db
      .select({ name: users.name })
      .from(users)
      .where(inArray(users.status, ["active", "invited"])),
    // Shared mailboxes ("Support", "Customer care") are generic names that
    // vendors use too; only personal mailboxes name a person.
    db
      .select({ name: mailboxes.displayName })
      .from(mailboxes)
      .where(isNotNull(mailboxes.ownerUserId)),
  ]);

  return {
    domains: [...configuredMailDomains()],
    names: protectedNames([...userRows, ...mailboxRows].map((row) => row.name)),
  };
}

const identityCache = isolateCache(WORKSPACE_CACHE_TTL_MS, workspaceIdentity);

/**
 * `workspaceIdentity` reused for up to a minute in this isolate, for showing
 * mail: a new person or domain reaches the reader's impersonation and
 * external-sender hints within that minute. Delivery reads it fresh.
 */
export function cachedWorkspaceIdentity(binding: D1Database) {
  return identityCache.get(binding);
}

/** The Spamhaus DQS key from the SPAMHAUS_DQS_KEY secret, when set and well-formed. */
export function spamhausDqsKey(env: { SPAMHAUS_DQS_KEY?: string }) {
  const key = env.SPAMHAUS_DQS_KEY?.trim().toLowerCase();

  if (!key) return null;

  if (!DQS_KEY_PATTERN.test(key)) {
    console.error(
      "SPAMHAUS_DQS_KEY is not a Spamhaus DQS key; blocklist checks are off"
    );

    return null;
  }

  return key;
}
