import type { AppEnv } from "@open-workspace/core/module";
import { apiError } from "@open-workspace/core/module";
import { Hono } from "hono";

import type { OneClickFetcher } from "./unsubscribe";

/**
 * Demo newsletters point their RFC 8058 endpoint at this reserved host. The
 * unsubscribe route answers it in-process (never over the network), and
 * only while mock authentication is enabled.
 */
export const DEMO_UNSUBSCRIBE_HOST = "unsubscribe.openworkspace-demo.invalid";

export const demoRoutes = new Hono<AppEnv>().post(
  "/list-unsubscribe/:token",
  async (c) => {
    if (c.env.ALLOW_MOCK_AUTH !== "true") {
      return apiError(c, 404, "NOT_FOUND", "Not found");
    }

    const body = new TextDecoder().decode(await c.req.arrayBuffer());

    if (body.trim() !== "List-Unsubscribe=One-Click") {
      return apiError(
        c,
        400,
        "BAD_REQUEST",
        "Expected an RFC 8058 one-click body"
      );
    }

    return c.text("You have been unsubscribed.");
  }
);

/** Real endpoints go to the network; the demo host is served by `demoRoutes`. */
export function oneClickFetcher(env: Env): OneClickFetcher {
  return (request) => {
    const url = new URL(request.url);

    if (
      env.ALLOW_MOCK_AUTH === "true" &&
      url.hostname === DEMO_UNSUBSCRIBE_HOST
    ) {
      const local = new URL(
        `/list-unsubscribe${url.pathname.replace(/^\/[^/]*/u, "")}`,
        "http://demo.local"
      );

      return Promise.resolve(
        demoRoutes.fetch(new Request(local, request), env)
      );
    }

    return fetch(request);
  };
}
