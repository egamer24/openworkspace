import { describe, expect, it } from "bun:test";

import { Hono } from "hono";
import { setCookie } from "hono/cookie";

import { sessionCookie } from "../../worker/auth/session.ts";

describe("the session cookie", () => {
  it("is __Host-op_session, Secure, Path=/, with no Domain on every real origin", () => {
    for (const [url, env] of [
      ["https://mail.example.com/", {}],
      ["http://mail.example.com/", {}],
      // A mock-auth workspace still gets the Secure cookie over HTTPS.
      ["https://mail.example.com/", { ALLOW_MOCK_AUTH: "true" }],
    ] as const) {
      const cookie = sessionCookie(new Request(url), env);
      expect(cookie.name).toBe("__Host-op_session");
      expect(cookie.options).toMatchObject({
        secure: true,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      });
      expect(cookie.options).not.toHaveProperty("domain");
    }
  });

  it("is accepted by Hono, which enforces the prefix's rules", async () => {
    const app = new Hono().get("/", (c) => {
      const cookie = sessionCookie(c.req.raw, {});
      setCookie(c, cookie.name, "token", cookie.options);

      return c.body(null, 204);
    });

    const header = (await app.request("https://mail.example.com/")).headers.get(
      "set-cookie"
    );

    expect(header).toBe(
      "__Host-op_session=token; Path=/; HttpOnly; Secure; SameSite=Lax"
    );
  });

  it("is a plain cookie only for local development over HTTP", () => {
    const cookie = sessionCookie(new Request("http://localhost:5173/"), {
      ALLOW_MOCK_AUTH: "true",
    });

    expect(cookie.name).toBe("op_session_dev");
    expect(cookie.options.secure).toBe(false);
  });
});
