import type { AppEnv } from "@open-workspace/core/module";
import { timed } from "@open-workspace/core/module";
import type { Context } from "hono";

import { mailS3 } from "./r2-presigned-urls";
import { fetchProxiedRemoteMedia } from "./remote-proxy";

/*
 * The colo-local Cache API in front of R2 message bodies and remote images.
 * Entries live under synthetic URLs (an .invalid host the Worker never
 * serves), so only this code reads them: no client request reaches one.
 * Both caches are best effort; a failing cache falls through to the source.
 */

/** Stored bodies never change; a day bounds how long a deleted one lingers. */
const BODY_TTL_SECONDS = 24 * 60 * 60;

/** Bodies above this go straight to R2 every time. */
const MAX_CACHED_BODY_BYTES = 2 * 1024 * 1024;

/** Remote images are shared by everyone who opens the same newsletter. */
const REMOTE_TTL_SECONDS = 24 * 60 * 60;

async function openCache(name: string) {
  try {
    return await caches.open(name);
  } catch {
    return null;
  }
}

function background(c: Context<AppEnv>, work: Promise<unknown>) {
  const guarded = work.catch(() => undefined);

  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // No execution context (in-process calls): the promise still runs.
  }
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * A stored message body (HTML) by its R2 key: from this colo's cache when an
 * earlier request put it there, else from R2, then cached.
 */
export async function readStoredBody(c: Context<AppEnv>, key: string) {
  const cache = await openCache("openworkspace:mail-bodies");

  // The bucket name keeps workspaces that share a zone apart.
  const request = new Request(
    `https://mail-bodies.openworkspace.invalid/v1/${encodeURIComponent(mailS3(c.env).bucketName)}/${encodeURIComponent(key)}`
  );

  const hit = cache
    ? await timed(c, "cache", "body", () =>
        cache.match(request).catch(() => undefined)
      )
    : undefined;

  if (hit) return await hit.text();

  const object = await timed(c, "r2", "body", () =>
    c.env.MAIL_STORAGE.get(key)
  );

  if (!object) return null;
  const html = await object.text();

  if (cache && object.size <= MAX_CACHED_BODY_BYTES) {
    background(
      c,
      cache.put(
        request,
        new Response(html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": `max-age=${BODY_TTL_SECONDS}`,
          },
        })
      )
    );
  }

  return html;
}

/**
 * A remote image through the proxy's guards (remote-proxy.ts): from this
 * colo's cache, keyed by the URL alone, or fetched, then cached. `beforeFetch`
 * runs only when the origin is about to be asked (rate limiting); returning
 * false stops there with `limited`.
 */
export async function proxiedRemoteImage(
  c: Context<AppEnv>,
  url: string,
  beforeFetch: () => Promise<boolean>
): Promise<
  | { outcome: "ok"; body: ArrayBuffer | ReadableStream; contentType: string }
  | { outcome: "limited" }
> {
  const cache = await openCache("openworkspace:mail-remote");

  const request = new Request(
    `https://mail-remote.openworkspace.invalid/v1/${await sha256Hex(url)}`
  );

  const hit = cache
    ? await timed(c, "cache", "remote", () =>
        cache.match(request).catch(() => undefined)
      )
    : undefined;

  if (hit?.body) {
    return {
      outcome: "ok",
      body: hit.body,
      contentType:
        hit.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  if (!(await beforeFetch())) return { outcome: "limited" };

  const remote = await timed(c, "fetch", "origin", () =>
    fetchProxiedRemoteMedia(url)
  );

  if (cache) {
    background(
      c,
      cache.put(
        request,
        new Response(remote.body.slice(0), {
          headers: {
            "content-type": remote.contentType,
            "cache-control": `max-age=${REMOTE_TTL_SECONDS}`,
          },
        })
      )
    );
  }

  return { outcome: "ok", body: remote.body, contentType: remote.contentType };
}
