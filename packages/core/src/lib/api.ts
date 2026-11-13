import { hc } from "hono/client";
import { z } from "zod";

import { D1_BOOKMARK_HEADER } from "../../shared/d1-bookmark";
import type { AppType } from "../../worker/index";

let d1Bookmark: string | null = null;

/**
 * Keeps the newest D1 bookmark this tab has seen (bookmarks sort by age),
 * e.g. from a response or a realtime message about a write made elsewhere.
 */
export function noteD1Bookmark(bookmark: string | null | undefined) {
  if (bookmark && (!d1Bookmark || bookmark > d1Bookmark)) d1Bookmark = bookmark;
}

/**
 * `fetch` for the workspace's API: sends the newest D1 bookmark, so reads may
 * use a replica yet still see every write this tab has seen, and keeps the
 * one each response returns. Without one (a fresh page), the server starts
 * on the primary.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit) {
  const headers = new Headers(init?.headers);

  if (d1Bookmark) headers.set(D1_BOOKMARK_HEADER, d1Bookmark);
  const response = await fetch(input, { ...init, headers });
  noteD1Bookmark(response.headers.get(D1_BOOKMARK_HEADER));

  return response;
}

export const api = hc<AppType>(window.location.origin, { fetch: apiFetch });
export const AUTH_UNAUTHORIZED_EVENT = "openworkspace:auth-unauthorized";

/** Every API route answers with `{ ok: true, … }` or `{ ok: false, error }`. */
type ApiBody = { ok: boolean };

/** What `responseJson` needs of a Hono client response. */
type ResponseLike = {
  ok: boolean;
  status: number;
  json(): Promise<ApiBody>;
};

/** The body of a route's successful response: one of its `{ ok: true, … }` bodies. */
export type SuccessfulResponse<R extends ResponseLike> = Extract<
  Awaited<ReturnType<R["json"]>>,
  { ok: true }
>;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const successBody = z.object({ ok: z.literal(true) });

const failureBody = z.object({
  error: z.object({ message: z.string() }),
});

export async function responseJson<R extends ResponseLike>(
  response: R
): Promise<SuccessfulResponse<R>> {
  const body = await response.json();

  if (response.ok && successBody.safeParse(body).success) {
    // SAFETY: `body` is what this `R`'s `json()` resolved to and it has
    // `ok: true`, so it is one of `R`'s successful bodies; through the generic
    // call TypeScript only sees the constraint's `ApiBody`.
    return body as SuccessfulResponse<R>;
  }

  if (response.status === 401) {
    window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
  }

  const failure = failureBody.safeParse(body);
  throw new ApiError(
    failure.success
      ? failure.data.error.message
      : `Request failed (${response.status})`,
    response.status
  );
}
