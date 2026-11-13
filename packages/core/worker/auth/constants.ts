/**
 * The session cookie: host-only, Secure, for the whole site. The __Host-
 * prefix makes browsers refuse it unless it is all three, so a sibling
 * subdomain or a plain-HTTP page cannot plant or widen it.
 */
export const SESSION_COOKIE = "__Host-op_session";

/**
 * Local development over plain HTTP (alchemy dev, the stack tests), where a
 * Secure cookie may not be stored and so no __Host- one either.
 */
export const DEV_SESSION_COOKIE = "op_session_dev";
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RECOVERY_TTL_MS = 60 * 60 * 1000;

/** How long a session lasts since it was last renewed. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
