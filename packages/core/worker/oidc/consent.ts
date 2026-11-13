import type { OidcClientRegistration } from "../../shared/oidc";
import type { SessionUser } from "../env";
import { coveredScopes, scopeInfo } from "./scopes";

function hostOf(uri: string) {
  try {
    return new URL(uri).host;
  } catch {
    return null;
  }
}

/**
 * What the consent screen shows for a pending authorization: who is asking,
 * where it will send the person back, and each scope in plain language.
 * Scopes the person may not grant (their role does not cover them) are
 * listed apart; approving leaves them out.
 */
export function consentView(
  request: {
    id: string;
    clientId: string;
    clientName: string;
    clientRegistration: OidcClientRegistration;
    redirectUri: string;
    scopes: string[];
    expiresAt: Date;
  },
  user: Pick<SessionUser, "role" | "permissions">
) {
  const available = coveredScopes(user, request.scopes);

  // A metadata-document client is its URL; that host vouches for the app.
  const clientHost =
    request.clientRegistration === "metadata_document"
      ? hostOf(request.clientId)
      : null;

  const redirectHost = hostOf(request.redirectUri);

  const redirectHostname = redirectHost
    ? new URL(request.redirectUri).hostname
    : null;

  return {
    id: request.id,
    clientName: request.clientName,
    clientRegistration: request.clientRegistration,
    clientHost,
    redirectHost: redirectHost ?? request.redirectUri,
    /** The app sends people back somewhere other than the host that publishes it. */
    redirectElsewhere:
      clientHost !== null &&
      redirectHostname !== new URL(request.clientId).hostname,
    scopes: scopeInfo(available),
    unavailableScopes: scopeInfo(
      request.scopes.filter((scope) => !available.includes(scope))
    ),
    expiresAt: request.expiresAt,
  };
}
