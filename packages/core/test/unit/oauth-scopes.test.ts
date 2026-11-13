import { describe, expect, it } from "bun:test";

import { Hono } from "hono";

import {
  oauthScope,
  oauthScopeAnyOf,
  oauthScopeRefusal,
} from "../../worker/auth/oauth-scopes.ts";
import type { AppEnv } from "../../worker/env.ts";

/** An API whose requests carry an app's token with `scopes`, checked as requireAuth checks them. */
function api(scopes: string[]) {
  const routes = new Hono<AppEnv>()
    .use("/admin/*", oauthScope("admin.people"))
    .get("/admin/users", (c) => c.text("users"))
    .post("/admin/users/:id/link", oauthScope("admin.access"), (c) =>
      c.text("link")
    )
    .get("/mailboxes", oauthScopeAnyOf("admin.people", "admin.teams"), (c) =>
      c.text("mailboxes")
    )
    .get("/untagged", (c) => c.text("untagged"));

  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      c.set("authKind", "oauth");
      c.set("oauthScopes", scopes);
      const refusal = oauthScopeRefusal(c);

      if (refusal) return refusal;
      await next();
    })
    .route("/api", routes);
}

describe("OAuth scope requirements", () => {
  it("refuse a route that declares none", async () => {
    const response = await api(["admin.people", "admin.access"]).request(
      "/api/untagged"
    );

    expect(response.status).toBe(403);
  });

  it("need every scope declared along the way", async () => {
    expect(
      (await api(["admin.people"]).request("/api/admin/users")).status
    ).toBe(200);
    expect(
      (await api(["admin.access"]).request("/api/admin/users")).status
    ).toBe(403);

    const link = (scopes: string[]) =>
      api(scopes).request("/api/admin/users/usr_1/link", { method: "POST" });

    expect((await link(["admin.people"])).status).toBe(403);
    expect((await link(["admin.access"])).status).toBe(403);
    const refused = await link(["admin.people"]);
    expect(refused.headers.get("www-authenticate")).toBe(
      'Bearer error="insufficient_scope", scope="admin.access"'
    );
    expect((await link(["admin.people", "admin.access"])).status).toBe(200);
  });

  it("take one of an any-of list", async () => {
    expect((await api(["admin.teams"]).request("/api/mailboxes")).status).toBe(
      200
    );
    expect((await api(["mail.read"]).request("/api/mailboxes")).status).toBe(
      403
    );
  });

  it("read the route Hono decoded, as the handler sees it", async () => {
    expect((await api([]).request("/api/%61dmin/users")).status).toBe(403);
    expect(
      (await api(["admin.people"]).request("/api/%61dmin/users")).status
    ).toBe(200);
  });
});
