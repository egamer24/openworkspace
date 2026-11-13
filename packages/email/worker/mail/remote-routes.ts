import type { AppEnv } from "@open-workspace/core/module";
import {
  apiError,
  rateLimitedResponse,
  withinRateLimit,
  timed,
  zValidator,
} from "@open-workspace/core/module";
import { Hono } from "hono";

import { proxiedRemoteImage } from "./edge-cache";
import { assertProxyableRemoteUrl } from "./remote-proxy";
import { verifyRemoteToken } from "./remote-token";
import { remoteProxyQuerySchema } from "./schemas";

/**
 * GET /api/mail/remote: remote images in sanitized message HTML, fetched
 * here so the sender never sees the reader. The URL's token (remote-token.ts)
 * is the only credential: no session or mailbox lookup, nothing in D1.
 * Origin fetches are rate limited per person; images any reader fetched
 * come from the colo's cache.
 */
export const mailRemoteRoutes = new Hono<AppEnv>().get(
  "/",
  zValidator("query", remoteProxyQuerySchema),
  async (c) => {
    const { mailboxId, token, url } = c.req.valid("query");

    const userId = await timed(c, "auth", "token", () =>
      verifyRemoteToken(c.env.MAIL_REMOTE_KEY, token, mailboxId, url)
    );

    if (!userId) {
      return apiError(
        c,
        403,
        "FORBIDDEN",
        "Remote content link is invalid or expired"
      );
    }

    try {
      assertProxyableRemoteUrl(url);
    } catch (error) {
      return apiError(
        c,
        400,
        "BAD_REQUEST",
        error instanceof Error ? error.message : "Remote URL is invalid"
      );
    }

    try {
      // Origin fetches, per person.
      const image = await proxiedRemoteImage(c, url, () =>
        timed(c, "limit", "remote", () =>
          withinRateLimit(c, "RATE_LIMIT_120", "mail-remote", userId)
        )
      );

      if (image.outcome === "limited") {
        return rateLimitedResponse(
          c,
          "Too many remote content requests. Try again shortly."
        );
      }

      return new Response(image.body, {
        headers: {
          // The token in the URL changes with each token window.
          "cache-control": "private, max-age=43200",
          "content-type": image.contentType,
          "content-disposition": "inline",
          "cross-origin-resource-policy": "same-origin",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      return apiError(
        c,
        502,
        "BAD_GATEWAY",
        error instanceof Error ? error.message : "Remote content unavailable"
      );
    }
  }
);
