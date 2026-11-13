import { beforeAll, describe, expect, it } from "bun:test";

import { z } from "zod";

import { required } from "../../shared/invariant.ts";
import { env, useFreshWorkspace, worker } from "../../testing/client.ts";
import { passkeyRegistration } from "../fixtures/passkey.ts";

useFreshWorkspace();

const origin = "http://example.test";
let adminCookie = "";

const count = async (sql: string, ...params: string[]) =>
  required(
    await env.DB.prepare(sql)
      .bind(...params)
      .first<{ n: number }>(),
    "count(*) returns a row"
  ).n;

const accessLinkResponse = z.object({
  accessLink: z.object({ userId: z.string(), url: z.string() }),
});

const registrationStart = z.object({
  options: z.object({
    challenge: z.string(),
    rp: z.object({ id: z.string().optional() }),
  }),
  challengeId: z.string(),
});

const errorResponse = z.object({ error: z.object({ message: z.string() }) });

beforeAll(async () => {
  const bootstrap = await worker.fetch(
    new Request(`${origin}/api/auth/mock/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    })
  );

  expect(bootstrap.status).toBe(200);
  adminCookie = required(
    bootstrap.headers.get("set-cookie")?.split(";", 1)[0],
    "sign-up sets a session cookie"
  );
});

/** An administrator's POST: an invitation's details, or none. */
function admin(path: string, json?: { name: string; email: string }) {
  const headers = new Headers({ cookie: adminCookie, origin });

  if (json !== undefined) headers.set("content-type", "application/json");

  return worker.fetch(
    new Request(`${origin}${path}`, {
      method: "POST",
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    })
  );
}

const tokenOf = (url: string) =>
  required(
    new URL(url).pathname.split("/").at(-1),
    "an access link ends in its token"
  );

async function invite(name: string) {
  const response = await admin("/api/admin/invitations", {
    name,
    email: `${name.toLowerCase()}@example.test`,
  });

  expect(response.status).toBe(201);

  const { accessLink } = accessLinkResponse.parse(await response.json());

  return { userId: accessLink.userId, token: tokenOf(accessLink.url) };
}

/** Starts a passkey registration with the link; finishing it is up to `finish`. */
async function start(kind: "invitation" | "recovery", token: string) {
  const options = await worker.fetch(
    new Request(`${origin}/api/auth/${kind}/${token}/options`, {
      method: "POST",
    })
  );

  expect(options.status).toBe(200);

  const started = registrationStart.parse(await options.json());

  const response = await passkeyRegistration(started.options, origin);

  return () =>
    worker.fetch(
      new Request(`${origin}/api/auth/${kind}/${token}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ challengeId: started.challengeId, response }),
      })
    );
}

async function expectRefused(response: Response) {
  expect(response.status).toBe(400);
  expect(errorResponse.parse(await response.json()).error.message).toBe(
    "Access link is invalid or expired"
  );
}

const passkeys = (userId: string) =>
  count(
    "SELECT count(*) AS n FROM passkey_credentials WHERE user_id = ?",
    userId
  );

const claims = (userId: string) =>
  count(
    "SELECT count(*) AS n FROM access_link_claims WHERE user_id = ?",
    userId
  );

describe("access-link redemption", () => {
  it("refuses a used link and stores nothing of the second redemption", async () => {
    const { userId, token } = await invite("Used");
    // Both ceremonies start while the link is unused; the second finishes after the first.
    const first = await start("invitation", token);
    const second = await start("invitation", token);
    expect((await first()).status).toBe(200);
    await expectRefused(await second());
    expect(await passkeys(userId)).toBe(1);
    expect(await claims(userId)).toBe(1);
  });

  it("refuses an expired invitation: no passkey, no claim, the person stays invited", async () => {
    const { userId, token } = await invite("Expired");
    const finish = await start("invitation", token);
    await env.DB.prepare(
      "UPDATE access_links SET expires_at = ? WHERE user_id = ?"
    )
      .bind(Date.now() - 1000, userId)
      .run();
    await expectRefused(await finish());
    expect(await passkeys(userId)).toBe(0);
    expect(await claims(userId)).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM users WHERE id = ? AND status = 'invited'",
        userId
      )
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM access_links WHERE user_id = ? AND consumed_at IS NULL",
        userId
      )
    ).toBe(1);
  });

  it("refuses an expired recovery link: the old passkey and sessions stay", async () => {
    const { userId, token } = await invite("Recovering");
    expect((await (await start("invitation", token))()).status).toBe(200);

    const [before] = (
      await env.DB.prepare(
        "SELECT credential_id FROM passkey_credentials WHERE user_id = ?"
      )
        .bind(userId)
        .all<{ credential_id: string }>()
    ).results;

    const sessions = await count(
      "SELECT count(*) AS n FROM sessions WHERE user_id = ?",
      userId
    );

    expect(sessions).toBeGreaterThan(0);

    const link = await admin(`/api/admin/users/${userId}/access-link`);
    expect(link.status).toBe(201);

    const recovery = tokenOf(
      accessLinkResponse.parse(await link.json()).accessLink.url
    );

    const finish = await start("recovery", recovery);
    await env.DB.prepare(
      "UPDATE access_links SET expires_at = ? WHERE user_id = ? AND kind = 'recovery'"
    )
      .bind(Date.now() - 1000, userId)
      .run();
    await expectRefused(await finish());

    const after = (
      await env.DB.prepare(
        "SELECT credential_id FROM passkey_credentials WHERE user_id = ?"
      )
        .bind(userId)
        .all<{ credential_id: string }>()
    ).results;

    expect(after).toEqual([
      required(before, "the invitation stored a passkey"),
    ]);
    expect(
      await count(
        "SELECT count(*) AS n FROM sessions WHERE user_id = ?",
        userId
      )
    ).toBe(sessions);
    expect(await claims(userId)).toBe(1);
  });

  it("lets exactly one of several concurrent redemptions through", async () => {
    const { userId, token } = await invite("Racing");

    const finishes = await Promise.all(
      Array.from({ length: 4 }, () => start("invitation", token))
    );

    const responses = await Promise.all(finishes.map((finish) => finish()));
    expect(
      responses.filter((response) => response.status === 200)
    ).toHaveLength(1);

    await Promise.all(
      responses.flatMap((response) =>
        response.status === 200 ? [] : [expectRefused(response)]
      )
    );

    expect(await passkeys(userId)).toBe(1);
    expect(await claims(userId)).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM users WHERE id = ? AND status = 'active'",
        userId
      )
    ).toBe(1);
  });
});
