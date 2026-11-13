import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";

import { avatarImage, avatarPath, avatarSizes } from "../../shared/avatar";
import type { AvatarSize } from "../../shared/avatar";
import type { Database } from "../db/client";
import { createDb } from "../db/client";
import { users } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { overRateLimit, rateLimitedResponse } from "../lib/rate-limit";
import {
  deleteStoredImage,
  IMAGE_KEY_PATTERN,
  newImageKey,
  serveStoredImage,
  sniffImageType,
  storeImage,
} from "../lib/stored-image";

/** An avatar's key in the media bucket, by its owner and the key each upload gets (`newImageKey`). */
export function avatarObjectKey(userId: string, avatarId: string) {
  return `avatars/${userId}/${avatarId}`;
}

/** The person's current avatar id, in a batch that changes it. */
function avatarIdQuery(db: Database, userId: string) {
  return db
    .select({ avatarId: users.avatarId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
}

async function rateLimitAvatar(c: Context<AppEnv>, userId: string) {
  if (!(await overRateLimit(c, "RATE_LIMIT_10", "avatar-upload", userId))) {
    return null;
  }

  return rateLimitedResponse(c, "Too many avatar updates");
}

export async function uploadAvatar(c: Context<AppEnv>) {
  const user = c.get("user");
  const limited = await rateLimitAvatar(c, user.id);

  if (limited) return limited;

  let form: FormData;

  try {
    form = await c.req.formData();
  } catch {
    return apiError(c, 400, "BAD_REQUEST", "Expected multipart form data");
  }

  const file = form.get("file");

  if (!(file instanceof File)) {
    return apiError(c, 400, "BAD_REQUEST", "Choose an image file to upload");
  }

  if (file.size <= 0 || file.size > avatarImage.maxBytes) {
    return apiError(c, 400, "BAD_REQUEST", "Avatar must be at most 2 MB");
  }

  const bytes = await file.arrayBuffer();
  const type = sniffImageType(new Uint8Array(bytes), avatarImage.types);

  if (!type) {
    return apiError(
      c,
      400,
      "BAD_REQUEST",
      "Avatar must be a JPEG, PNG, WebP, or GIF image"
    );
  }

  const avatarId = newImageKey();

  try {
    await storeImage(c.env, avatarObjectKey(user.id, avatarId), bytes, type);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Avatar upload failed";

    return apiError(c, 502, "BAD_GATEWAY", message);
  }

  const db = createDb(c.env.DB);

  // One batch, one transaction: the id read is the one replaced.
  const [[previous]] = await db.batch([
    avatarIdQuery(db, user.id),
    db
      .update(users)
      .set({ avatarId, updatedAt: new Date() })
      .where(eq(users.id, user.id)),
  ]);

  if (previous?.avatarId) {
    await deleteStoredImage(c.env, avatarObjectKey(user.id, previous.avatarId));
  }

  return c.json({ ok: true as const, avatarId });
}

export async function deleteAvatar(c: Context<AppEnv>) {
  const user = c.get("user");
  const limited = await rateLimitAvatar(c, user.id);

  if (limited) return limited;

  const db = createDb(c.env.DB);

  const [[previous]] = await db.batch([
    avatarIdQuery(db, user.id),
    db
      .update(users)
      .set({ avatarId: null, updatedAt: new Date() })
      .where(eq(users.id, user.id)),
  ]);

  if (previous?.avatarId) {
    await deleteStoredImage(c.env, avatarObjectKey(user.id, previous.avatarId));
  }

  return c.json({ ok: true as const, avatarId: null });
}

/** The absolute URL of a person's avatar, for apps (the OIDC `picture` claim); null without one. */
export function avatarUrl(
  origin: string,
  user: { id: string; avatarId: string | null }
) {
  return user.avatarId
    ? new URL(avatarPath(user.id, user.avatarId, 256), origin).toString()
    : null;
}

function avatarSize(value: string | undefined): AvatarSize | null {
  const size = Number(value);

  return avatarSizes.find((candidate) => candidate === size) ?? null;
}

/**
 * GET /api/avatars/:userId/:avatarId?size=…, public: a square WebP of one of
 * `avatarSizes`. Apps that sign people in show it from their own sites (the
 * `picture` claim), so it needs no session and other sites may embed it.
 * The URL names a random user id and a random key that only the person's
 * own sessions and the people and apps shown their avatar learn; a replaced
 * or removed photo is deleted, and its URL is a 404.
 */
export const avatarRoutes = new Hono<AppEnv>().get(
  `/:userId{[A-Za-z0-9_-]{1,64}}/:avatarId{${IMAGE_KEY_PATTERN}}`,
  async (c) => {
    const size = avatarSize(c.req.query("size"));

    if (!size) {
      return apiError(
        c,
        400,
        "BAD_REQUEST",
        `The size must be one of ${avatarSizes.join(", ")}`
      );
    }

    return await serveStoredImage(c, {
      key: avatarObjectKey(c.req.param("userId"), c.req.param("avatarId")),
      types: avatarImage.types,
      size,
      format: "image/webp",
      crossOrigin: true,
      missing: "This person has no photo",
    });
  }
);
