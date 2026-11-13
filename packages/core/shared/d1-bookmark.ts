/**
 * The header that carries a D1 Sessions API bookmark both ways: the browser
 * sends the newest one it has seen, and the Worker returns the session's
 * (worker/lib/d1-session.ts, src/lib/api.ts).
 */
export const D1_BOOKMARK_HEADER = "x-d1-bookmark";
