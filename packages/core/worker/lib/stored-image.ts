import type { Context } from "hono";

import type { AppEnv } from "../env";
import { apiError } from "./http";

/** Raster types the Worker accepts for uploaded images; never SVG, which can carry script. */
export type ImageType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** The image type the bytes start with, if it is one of `allowed`; the declared type is not trusted. */
export function sniffImageType<Type extends ImageType>(
  bytes: Uint8Array,
  allowed: readonly Type[]
): Type | null {
  const starts = (signature: number[], offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte);

  let type: ImageType | null = null;

  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    type = "image/png";
  } else if (starts([0xff, 0xd8, 0xff])) type = "image/jpeg";
  // RIFF....WEBP
  else if (
    starts([0x52, 0x49, 0x46, 0x46]) &&
    starts([0x57, 0x45, 0x42, 0x50], 8)
  ) {
    type = "image/webp";
  }
  // GIF87a / GIF89a
  else if (
    starts([0x47, 0x49, 0x46, 0x38]) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    type = "image/gif";
  }

  return allowed.find((candidate) => candidate === type) ?? null;
}

/**
 * A new image's key: every upload is stored under a new R2 key
 * (`<prefix>/<key>`), so the URL built from it can be cached for good.
 */
export function newImageKey() {
  return crypto.randomUUID().replaceAll("-", "");
}

/** What `newImageKey` returns, as a route parameter pattern. */
export const IMAGE_KEY_PATTERN = "[0-9a-f]{32}";

/** Stores the validated `bytes` of an upload in the media bucket under `key`, as `type`. */
export async function storeImage(
  env: Env,
  key: string,
  bytes: ArrayBuffer,
  type: ImageType
) {
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: type } });
}

/**
 * Deletes a replaced or removed image. Best effort: what is saved already
 * no longer points at it, so a failure only leaves an unused object behind.
 */
export async function deleteStoredImage(env: Env, key: string) {
  try {
    await env.MEDIA.delete(key);
  } catch (error) {
    console.error(`Could not delete the image ${key}`, error);
  }
}

/**
 * Resized images in this colo's Cache API, under synthetic URLs on an
 * .invalid host the Worker never serves. Keys hold a random id that is never
 * reused, so entries need no purge: a replaced image's key is simply never
 * asked for again. Best effort; a failing cache falls through to a resize.
 */
const RESIZED_CACHE = "openworkspace:resized-images";
const RESIZED_TTL_SECONDS = 365 * 24 * 60 * 60;

async function openResizedCache() {
  try {
    return await caches.open(RESIZED_CACHE);
  } catch {
    return null;
  }
}

function resizedCacheRequest(key: string, size: number, format: SquareFormat) {
  return new Request(
    `https://resized-images.openworkspace.invalid/v1/${encodeURIComponent(key)}?size=${size}&format=${encodeURIComponent(format)}`
  );
}

function inBackground(c: Context<AppEnv>, work: Promise<unknown>) {
  const guarded = work.catch(() => undefined);

  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // No execution context (in-process calls): the promise still runs.
  }
}

/** The output formats `serveStoredImage` resizes to. */
type SquareFormat = "image/png" | "image/webp";

/**
 * The image as a square of `size` pixels, cropped to fill, made by the
 * Images binding from the bytes passed in (no Images storage); null when
 * it can't transform them, and the original is served instead.
 */
async function squareImage(
  env: Env,
  image: ReadableStream,
  size: number,
  format: SquareFormat
) {
  try {
    const result = await env.IMAGES.input(image)
      .transform({ width: size, height: size, fit: "cover" })
      .output({ format });

    return new Uint8Array(await new Response(result.image()).arrayBuffer());
  } catch (error) {
    console.error("Could not resize a stored image", error);

    return null;
  }
}

/**
 * Serves the image stored under `key` in the media bucket, as uploaded or,
 * with `size`, as a square of that many pixels in `format`. A key is never
 * reused (`newImageKey`), so the image is cached for a year; a failed resize
 * serves the original uncached, and the next request tries again. Missing
 * (deleted once replaced or removed), or not one of `types`, it is a 404.
 */
export async function serveStoredImage(
  c: Context<AppEnv>,
  input: {
    key: string;
    types: readonly ImageType[];
    size: number | null;
    format: SquareFormat;
    /** Whether other sites may embed it (`Cross-Origin-Resource-Policy`). */
    crossOrigin: boolean;
    /** The 404's message. */
    missing: string;
  }
) {
  const headers = {
    // An image, never a document.
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": input.crossOrigin
      ? "cross-origin"
      : "same-origin",
  };

  const immutable = "public, max-age=31536000, immutable";
  // A resize made here before is served without the binding. The object is
  // still checked (a cheap HEAD), so a removed photo stops being served at once.
  const cache = input.size ? await openResizedCache() : null;

  const cacheRequest = input.size
    ? resizedCacheRequest(input.key, input.size, input.format)
    : null;

  const hit =
    cache && cacheRequest
      ? await cache.match(cacheRequest).catch(() => undefined)
      : undefined;

  if (hit?.body) {
    if (await c.env.MEDIA.head(input.key)) {
      return c.body(hit.body, 200, {
        ...headers,
        "content-type": input.format,
        "cache-control": immutable,
      });
    }

    await hit.body.cancel();

    if (cache && cacheRequest) inBackground(c, cache.delete(cacheRequest));
  }

  const stored = async () => {
    const object = await c.env.MEDIA.get(input.key);
    const saved = object?.httpMetadata?.contentType;
    const type = input.types.find((candidate) => candidate === saved);

    if (object && type) return { body: object.body, type };

    await object?.body.cancel();

    return null;
  };

  const notFound = () => {
    c.header("cache-control", "no-store");

    return apiError(c, 404, "NOT_FOUND", input.missing);
  };

  const image = await stored();

  if (!image) return notFound();

  if (!input.size) {
    return c.body(image.body, 200, {
      ...headers,
      "content-type": image.type,
      "cache-control": immutable,
    });
  }

  const resized = await squareImage(
    c.env,
    image.body,
    input.size,
    input.format
  );

  if (resized) {
    if (cache && cacheRequest) {
      inBackground(
        c,
        cache.put(
          cacheRequest,
          new Response(resized.slice(), {
            headers: {
              "content-type": input.format,
              "cache-control": `max-age=${RESIZED_TTL_SECONDS}`,
            },
          })
        )
      );
    }

    return c.body(resized, 200, {
      ...headers,
      "content-type": input.format,
      "cache-control": immutable,
    });
  }

  // Images read the stream; the original is read again, and not kept.
  const original = await stored();

  if (!original) return notFound();

  return c.body(original.body, 200, {
    ...headers,
    "content-type": original.type,
    "cache-control": "no-cache",
  });
}
