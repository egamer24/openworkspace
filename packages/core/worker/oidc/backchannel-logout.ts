import { and, eq, isNotNull } from "drizzle-orm";

import type { Database } from "../db/client";
import { createDb } from "../db/client";
import {
  oidcAccessTokens,
  oidcClients,
  oidcGrants,
  oidcRefreshTokens,
} from "../db/schema";
import { sendInBatches } from "../lib/queue";
import { signLogoutToken } from "./keys";

const LOGOUT_REQUEST_TIMEOUT_MS = 10_000;

export type BackchannelLogoutJob = {
  type: "backchannel-logout";
  clientId: string;
  userId: string;
};

export class BackchannelLogoutError extends Error {
  constructor(
    message: string,
    /** Whether sending the same logout again may succeed. */
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "BackchannelLogoutError";
  }
}

/**
 * Who holds a session at which client: a consent, an access token, or a
 * refresh token. Read before revoking them, since revocation erases the trail.
 */
async function clientSessions(
  db: Database,
  filter: { userId: string } | { clientId: string }
) {
  const tables = [oidcGrants, oidcAccessTokens, oidcRefreshTokens] as const;

  const rows = await Promise.all(
    tables.map((table) =>
      db
        .selectDistinct({ clientId: table.clientId, userId: table.userId })
        .from(table)
        .innerJoin(oidcClients, eq(oidcClients.id, table.clientId))
        .where(
          and(
            "userId" in filter
              ? eq(table.userId, filter.userId)
              : eq(table.clientId, filter.clientId),
            isNotNull(oidcClients.backchannelLogoutUri)
          )
        )
    )
  );

  const unique = new Map<string, { clientId: string; userId: string }>();

  for (const row of rows.flat()) {
    unique.set(`${row.clientId}:${row.userId}`, row);
  }

  return [...unique.values()];
}

export async function queueBackchannelLogouts(
  env: Env,
  sessions: { clientId: string; userId: string }[]
) {
  await sendInBatches(
    env.IDENTITY_SYNC,
    sessions.map((session): BackchannelLogoutJob => ({
      type: "backchannel-logout",
      ...session,
    }))
  );
}

/** Sends one logout token to the client's back-channel logout URI. */
export async function deliverBackchannelLogout(
  env: Env,
  job: Pick<BackchannelLogoutJob, "clientId" | "userId">,
  fetcher: typeof fetch = fetch
) {
  const [client] = await createDb(env.DB)
    .select({ uri: oidcClients.backchannelLogoutUri })
    .from(oidcClients)
    .where(eq(oidcClients.id, job.clientId))
    .limit(1);

  // The client was deleted or no longer listens.
  if (!client?.uri) return;

  const logoutToken = await signLogoutToken(env, {
    clientId: job.clientId,
    userId: job.userId,
  });

  let response: Response;

  try {
    response = await fetcher(client.uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ logout_token: logoutToken }),
      redirect: "manual",
      signal: AbortSignal.timeout(LOGOUT_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new BackchannelLogoutError(
      `Back-channel logout request failed: ${error instanceof Error ? error.message : String(error)}`,
      true
    );
  }

  await response.body?.cancel();

  if (response.ok) return;
  throw new BackchannelLogoutError(
    `Back-channel logout returned HTTP ${response.status}`,
    response.status === 429 || response.status >= 500
  );
}

/** Clients the user is signed in to that should hear about it. */
export function userBackchannelSessions(db: Database, userId: string) {
  return clientSessions(db, { userId });
}

/** Sessions at one client held by people outside `keepUserIds`. */
export async function clientBackchannelSessions(
  db: Database,
  clientId: string,
  keepUserIds?: string[]
) {
  const sessions = await clientSessions(db, { clientId });

  if (!keepUserIds) return sessions;
  const keep = new Set(keepUserIds);

  return sessions.filter((session) => !keep.has(session.userId));
}
