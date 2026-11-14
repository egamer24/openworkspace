import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import {
  workspaceIconSizes,
  workspaceLogo,
  workspaceLogoPath,
  workspaceName,
} from "../shared/workspace";
import type { WorkspaceIconSize } from "../shared/workspace";
import { createDb } from "./db/client";
import type { Database } from "./db/client";
import { settings } from "./db/schema";
import type { AppEnv } from "./env";
import { apiError } from "./lib/http";
import { overRateLimit, rateLimitedResponse } from "./lib/rate-limit";
import {
  deleteStoredImage,
  IMAGE_KEY_PATTERN,
  newImageKey,
  serveStoredImage,
  sniffImageType,
  storeImage,
} from "./lib/stored-image";
import { zValidator } from "./lib/validator";

/** A logo's key in the media bucket, by the key each upload gets (`newImageKey`). */
export const logoObjectKey = (logoId: string) => `workspace/logo/${logoId}`;

/** The `settings` row holding the current logo's id; no row, no logo. */
export const LOGO_ID_KEY = "workspace_logo_id";

/** The `settings` row holding the workspace's name; no row, the product's name is shown. */
export const NAME_KEY = "workspace_name";

/** The current logo's id, from the `settings` row. */
function logoIdQuery(db: Database) {
  return db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, LOGO_ID_KEY))
    .limit(1);
}

/** The logo's id and the workspace's name, as `settings` rows for `workspaceBranding`. */
export function brandingQuery(db: Database) {
  return db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, [LOGO_ID_KEY, NAME_KEY]));
}

export type WorkspaceBranding = {
  /** The current logo's id, or null without a logo. */
  logoId: string | null;
  /** Where the current logo is served, or null without a logo. */
  logoUrl: string | null;
  /** The name an administrator gave the workspace, or null. */
  name: string | null;
};

/** The workspace's branding from `brandingQuery` rows. */
export function workspaceBranding(
  rows: { key: string; value: string }[]
): WorkspaceBranding {
  const value = (key: string) => rows.find((row) => row.key === key)?.value;
  const logoId = value(LOGO_ID_KEY) || null;

  return {
    logoId,
    logoUrl: logoId ? workspaceLogoPath(logoId) : null,
    name: value(NAME_KEY)?.trim() || null,
  };
}

/** The workspace's branding, read on its own. */
export async function loadBranding(db: Database) {
  return workspaceBranding(await brandingQuery(db));
}

async function rateLimitLogo(c: Context<AppEnv>) {
  if (
    !(await overRateLimit(
      c,
      "RATE_LIMIT_10",
      "workspace-logo",
      c.get("user").id
    ))
  ) {
    return null;
  }

  return rateLimitedResponse(c, "Too many logo changes; try again in a minute");
}

const nameSchema = z.object({
  /** Empty clears the name. */
  name: z
    .string()
    .trim()
    .max(workspaceName.maxLength)
    .regex(/^[^\p{Cc}]*$/u, "must be plain text"),
});

/**
 * Administration of the workspace's branding, at /api/admin/branding
 * (administrators only: the admin access guard keeps sections it has no
 * permission for to them): the logo, and the workspace's name.
 */
export const brandingAdminRoutes = new Hono<AppEnv>()
  .put("/name", zValidator("json", nameSchema), async (c) => {
    const { name } = c.req.valid("json");
    const db = createDb(c.env.DB);

    if (name) {
      const now = new Date();
      await db
        .insert(settings)
        .values({ key: NAME_KEY, value: name, updatedAt: now })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: name, updatedAt: now },
        });
    } else {
      await db.delete(settings).where(eq(settings.key, NAME_KEY));
    }

    return c.json({ ok: true as const, name: name || null });
  })
  .post("/logo", async (c) => {
    const limited = await rateLimitLogo(c);

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

    if (file.size <= 0 || file.size > workspaceLogo.maxBytes) {
      return apiError(c, 400, "BAD_REQUEST", "The logo must be at most 1 MB");
    }

    const buffer = await file.arrayBuffer();
    const type = sniffImageType(new Uint8Array(buffer), workspaceLogo.types);

    if (!type) {
      return apiError(
        c,
        400,
        "BAD_REQUEST",
        "The logo must be a PNG, JPEG, or WebP image"
      );
    }

    const logoId = newImageKey();

    try {
      await storeImage(c.env, logoObjectKey(logoId), buffer, type);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Logo upload failed";

      return apiError(c, 502, "BAD_GATEWAY", message);
    }

    const db = createDb(c.env.DB);
    const now = new Date();

    // One batch, one transaction: the id read is the one replaced.
    const [[previous]] = await db.batch([
      logoIdQuery(db),
      db
        .insert(settings)
        .values({ key: LOGO_ID_KEY, value: logoId, updatedAt: now })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: logoId, updatedAt: now },
        }),
    ]);

    if (previous) await deleteStoredImage(c.env, logoObjectKey(previous.value));

    return c.json({ ok: true as const, logoUrl: workspaceLogoPath(logoId) });
  })
  .delete("/logo", async (c) => {
    const limited = await rateLimitLogo(c);

    if (limited) return limited;
    const db = createDb(c.env.DB);

    const [[previous]] = await db.batch([
      logoIdQuery(db),
      db.delete(settings).where(eq(settings.key, LOGO_ID_KEY)),
    ]);

    if (previous) await deleteStoredImage(c.env, logoObjectKey(previous.value));

    return c.json({ ok: true as const, logoUrl: null });
  });

/** The OpenWorkspace icons (src/public/icons) shown without a logo, by size. */
function defaultIconPath(size: WorkspaceIconSize) {
  if (size <= 64) return "/icons/app-icon.svg";

  return size <= 192 ? "/icons/app-icon-192.png" : "/icons/app-icon-512.png";
}

function iconSize(value: string | undefined): WorkspaceIconSize | null {
  const size = Number(value);

  return workspaceIconSizes.find((candidate) => candidate === size) ?? null;
}

/**
 * GET /api/workspace-logo/:logoId, public: the screens around signing in
 * show it before anyone is signed in, and with `?size=` (one of
 * `workspaceIconSizes`) it is the favicon and the app's icons. The id (from
 * /api/bootstrap) names the image itself, so a read replica that has not
 * seen a new logo yet cannot hide it; a replaced or removed logo is a 404.
 *
 * GET /api/workspace-logo/icon/:size redirects to the current logo's icon,
 * or to the OpenWorkspace icon without a logo. It is revalidated on every
 * use (the favicon link, the manifest's fallback, push notifications), so a
 * new logo shows as soon as it is uploaded.
 */
export const logoRoutes = new Hono<AppEnv>()
  .get("/icon/:size", async (c) => {
    const size = iconSize(c.req.param("size"));

    if (!size) return apiError(c, 404, "NOT_FOUND", "No icon of this size");
    const { logoId } = await loadBranding(createDb(c.env.DB));
    c.header("cache-control", "no-cache");

    return c.redirect(
      logoId ? workspaceLogoPath(logoId, size) : defaultIconPath(size),
      302
    );
  })
  .get(`/:logoId{${IMAGE_KEY_PATTERN}}`, async (c) => {
    const requestedSize = c.req.query("size");
    const size = iconSize(requestedSize);

    if (requestedSize !== undefined && !size) {
      return apiError(
        c,
        400,
        "BAD_REQUEST",
        `The size must be one of ${workspaceIconSizes.join(", ")}`
      );
    }

    // Icons are PNG, which every browser and launcher takes.
    return await serveStoredImage(c, {
      key: logoObjectKey(c.req.param("logoId")),
      types: workspaceLogo.types,
      size,
      format: "image/png",
      crossOrigin: false,
      missing: "This workspace has no logo",
    });
  });

/** The installed app's colors: the light theme's page (theme.css). */
const appBackground = "#edeff4";

/**
 * GET /manifest.webmanifest: the installable app, named after the workspace
 * and with its logo as the icon when it has them. Maskable icons stay the
 * OpenWorkspace ones: a logo has no safe zone of its own for launchers to
 * crop into. Revalidated often, as its icon URLs change with the logo.
 */
export async function webManifest(c: Context<AppEnv>) {
  const { name, logoId } = await loadBranding(createDb(c.env.DB));
  const appName = name ?? "OpenWorkspace";

  const anyIcons = ([192, 512] as const).map((size) => ({
    src: logoId ? workspaceLogoPath(logoId, size) : defaultIconPath(size),
    sizes: `${size}x${size}`,
    type: "image/png",
    purpose: "any",
  }));

  const maskableIcons = ([192, 512] as const).map((size) => ({
    src: `/icons/app-icon-maskable-${size}.png`,
    sizes: `${size}x${size}`,
    type: "image/png",
    purpose: "maskable",
  }));

  const manifest = {
    id: "/",
    name: appName,
    short_name: appName,
    description:
      "Your team's workspace, hosted in your own Cloudflare account.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: appBackground,
    theme_color: appBackground,
    icons: [...anyIcons, ...maskableIcons],
    shortcuts: [{ name: "Open inbox", short_name: "Inbox", url: "/" }],
  };

  return c.body(JSON.stringify(manifest), 200, {
    "content-type": "application/manifest+json; charset=utf-8",
    "cache-control": "public, max-age=300",
  });
}
