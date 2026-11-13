import { D1_BOOKMARK_HEADER } from "../../shared/d1-bookmark";

/**
 * D1 read replication with the Sessions API: each request runs its queries in
 * one D1 session, so reads may go to a nearby replica while still seeing every
 * write the client has seen. The client sends the latest bookmark it got (in
 * this header) and gets the session's bookmark back in the same header.
 *
 * A request without a bookmark starts on the primary ("first-primary"): page
 * loads, sign-in redirects, OAuth and SAML flows and MCP clients carry none,
 * and may follow a write made elsewhere (e.g. a session created by the
 * previous response). Queue, cron, mail delivery and Durable Object code use
 * the plain binding, which always reaches the primary.
 */

/** Bookmarks are short opaque tokens; anything else is ignored. */
const BOOKMARK = /^[\w.:-]{1,256}$/u;

export function requestD1Session(binding: D1Database, request: Request) {
  const bookmark = request.headers.get(D1_BOOKMARK_HEADER);

  return binding.withSession(
    bookmark && BOOKMARK.test(bookmark) ? bookmark : "first-primary"
  );
}

/** `env` with its D1 binding replaced by `session`, for one request. */
export function withD1Session(env: Env, session: D1DatabaseSession): Env {
  return { ...env, DB: sessionDatabase(session) };
}

/**
 * A D1 binding that runs everything through `session`. Drizzle and the code
 * here use only prepare() and batch(), which a session has; the rest belong
 * to the binding itself, not to one request's session.
 */
function sessionDatabase(session: D1DatabaseSession): D1Database {
  const unavailable = (method: string) =>
    new Error(`D1 ${method}() is not available in a request's session`);

  return {
    prepare: (query) => session.prepare(query),
    batch: (statements) => session.batch(statements),
    exec: () => Promise.reject(unavailable("exec")),
    withSession: () => {
      throw unavailable("withSession");
    },
    dump: () => Promise.reject(unavailable("dump")),
  };
}

/** Adds the session's bookmark to an /api response. */
export function withBookmark(response: Response, session: D1DatabaseSession) {
  const bookmark = session.getBookmark();

  if (!bookmark || response.status === 101) return response;

  try {
    response.headers.set(D1_BOOKMARK_HEADER, bookmark);

    return response;
  } catch {
    // Immutable headers (a fetched response passed through).
    const copy = new Response(response.body, response);
    copy.headers.set(D1_BOOKMARK_HEADER, bookmark);

    return copy;
  }
}
