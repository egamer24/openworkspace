import { and, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { html } from "hono/html";
import { createDb } from "../db/client";
import { driveItems, driveLinks, users } from "../db/schema";
import type { AppEnv } from "../env";
import { hashToken, verifyPassword } from "../lib/crypto";
import { checkRateLimit } from "../lib/rate-limit";
import { cloudflareClientIp } from "../lib/request";
import { driveFileResponse, requireDriveEnabled } from "./service";

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

function page(c: Context<AppEnv>, status: 401 | 404 | 429, body: ReturnType<typeof html>) {
  c.header("content-security-policy", PAGE_CSP);
  c.header("cache-control", "no-store");
  c.header("referrer-policy", "no-referrer");
  return c.html(html`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shared file</title>
<style>body{font:15px system-ui,sans-serif;max-width:24rem;margin:15vh auto;padding:0 1rem;color:#222}input,button{font:inherit;padding:.5rem;width:100%;box-sizing:border-box;margin-top:.5rem}p.error{color:#b00}</style></head>
<body>${body}</body></html>`, status);
}

function notFound(c: Context<AppEnv>) {
  return page(c, 404, html`<p>This link is invalid, expired or has been revoked.</p>`);
}

function passwordForm(c: Context<AppEnv>, name: string, error: string | null) {
  return page(c, 401, html`<h1 style="font-size:1.1rem">${name}</h1>
<form method="post">
<label for="password">This file is password protected.</label>
<input id="password" name="password" type="password" autocomplete="off" required autofocus>
${error ? html`<p class="error">${error}</p>` : ""}
<button type="submit">Open</button>
</form>`);
}

/** Public share links: `/d/<token>`. The token is a random secret; only its hash is stored. */
export const drivePublicRoutes = new Hono<AppEnv>()
  .use("*", requireDriveEnabled)
  .on(["GET", "POST"], "/:token", async (c) => {
    const db = createDb(c.env.DB);
    const [row] = await db
      .select({ link: driveLinks, item: driveItems })
      .from(driveLinks)
      .innerJoin(driveItems, eq(driveItems.id, driveLinks.itemId))
      // Disabling the owner suspends their links; re-enabling restores them.
      .innerJoin(users, and(eq(users.id, driveItems.ownerUserId), eq(users.status, "active")))
      .where(eq(driveLinks.tokenHash, await hashToken(c.req.param("token"))))
      .limit(1);
    if (
      !row
      || (row.link.expiresAt && row.link.expiresAt.getTime() <= Date.now())
      || row.item.trashedAt
      || row.item.status !== "ready"
      || !row.item.r2Key
    ) {
      return notFound(c);
    }
    const { link, item } = row;

    if (link.passwordHash) {
      if (c.req.method !== "POST") return passwordForm(c, item.name, null);
      const rate = await checkRateLimit(c.env.DB, {
        action: "drive-link-password",
        identifier: `${link.id}:${cloudflareClientIp(c.req.raw) ?? "unknown"}`,
        limit: 10,
        windowMs: 60_000,
      });
      if (!rate.allowed) {
        c.header("retry-after", String(rate.retryAfterSeconds));
        return page(c, 429, html`<p>Too many attempts. Try again in a minute.</p>`);
      }
      const form = await c.req.parseBody();
      const password = typeof form.password === "string" ? form.password : "";
      if (!await verifyPassword(password, link.passwordHash)) {
        return passwordForm(c, item.name, "Incorrect password.");
      }
    }

    const object = await c.env.MAIL_STORAGE.get(item.r2Key!);
    if (!object) return notFound(c);
    await db
      .update(driveLinks)
      .set({ accessCount: sql`${driveLinks.accessCount} + 1`, lastAccessedAt: new Date() })
      .where(eq(driveLinks.id, link.id));
    const response = driveFileResponse(object, item, link.access === "view");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  });
