import { queueBackchannelLogouts } from "../oidc/backchannel-logout";

/*
 * Access to SSO apps follows team membership. Whenever who is in a team or
 * which teams an app admits changes, people who fell out lose their OIDC
 * consents and tokens, and apps that listen are told (back-channel logout).
 * Sign-in, token refresh and userinfo check access again anyway; this makes
 * the loss immediate and visible to the app.
 */

const sessionTables = [
  "oidc_grants",
  "oidc_access_tokens",
  "oidc_refresh_tokens",
  "oidc_authorization_codes",
] as const;

function lostAccess(table: string, clientId: string | undefined) {
  return `${clientId ? `${table}.client_id = ?1 AND ` : ""}NOT EXISTS (
    SELECT 1 FROM oidc_client_access
    WHERE oidc_client_access.client_id = ${table}.client_id
      AND oidc_client_access.user_id = ${table}.user_id
  )`;
}

/**
 * What an app receives in groups for the access teams a person is in: the
 * values set for those teams. A team without a value is not sent.
 */
export function groupValues(teams: { sentAs: string | null }[]) {
  return [
    ...new Set(teams.flatMap((team) => (team.sentAs ? [team.sentAs] : []))),
  ].sort();
}

/** Ends OIDC sessions held by people no longer in a team the client admits. */
export async function revokeLostOidcAccess(env: Env, clientId?: string) {
  const bind = (statement: D1PreparedStatement) =>
    clientId ? statement.bind(clientId) : statement;

  // Read who is signed in where before revoking erases the trail.
  const listening = await bind(
    env.DB.prepare(
      sessionTables
        .slice(0, 3)
        .map(
          (table) => `
      SELECT ${table}.client_id AS clientId, ${table}.user_id AS userId
      FROM ${table}
      INNER JOIN oidc_clients ON oidc_clients.id = ${table}.client_id
      WHERE oidc_clients.backchannel_logout_uri IS NOT NULL AND ${lostAccess(table, clientId)}
    `
        )
        .join(" UNION ")
    )
  ).all<{ clientId: string; userId: string }>();

  await env.DB.batch(
    sessionTables.map((table) =>
      bind(
        env.DB.prepare(
          `DELETE FROM ${table} WHERE ${lostAccess(table, clientId)}`
        )
      )
    )
  );

  if (listening.results.length) {
    await queueBackchannelLogouts(env, listening.results);
  }
}
