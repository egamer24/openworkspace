import { beforeAll, describe, expect, it } from "bun:test";

import { required } from "../../shared/invariant.ts";
import { env, hooks, useFreshWorkspace, worker } from "../../testing/client.ts";

useFreshWorkspace();

const origin = "http://example.test";
let adminCookie = "";
let adminId = "";

/** The session cookie a sign-in sets, as a Cookie header sends it back. */
const sessionCookie = (response: Response) =>
  required(
    response.headers.get("set-cookie")?.split(";", 1)[0],
    "signing in sets a session cookie"
  );

async function sessionIds(userId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id FROM sessions WHERE user_id = ? ORDER BY id"
  )
    .bind(userId)
    .all<{ id: string }>();

  return results.map((row) => row.id);
}

beforeAll(async () => {
  const bootstrap = await worker.fetch(
    new Request(`${origin}/api/auth/mock/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    })
  );

  expect(bootstrap.status).toBe(200);
  adminCookie = sessionCookie(bootstrap);

  const admin = required(
    await env.DB.prepare("SELECT id FROM users").first<{ id: string }>(),
    "the bootstrap creates the administrator"
  );

  adminId = admin.id;
});

describe("session revocation with module statements", () => {
  it("keeps the session when a module's statement fails, then revokes it", async () => {
    const [current] = await sessionIds(adminId);

    const login = await worker.fetch(
      new Request(`${origin}/api/auth/mock/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: adminId }),
      })
    );

    expect(login.status).toBe(200);

    const before = await sessionIds(adminId);
    expect(before).toHaveLength(2);

    const other = required(
      before.find((id) => id !== current),
      "the second sign-in stores a session"
    );

    const failed = await hooks.call<{ error?: string }>(
      "revocation.revokeSessionWithFailingModule",
      adminId,
      other
    );

    expect(failed.error).toBeDefined();
    expect(await sessionIds(adminId)).toEqual(before);

    const revoke = await worker.fetch(
      new Request(`${origin}/api/auth/sessions/${other}`, {
        method: "DELETE",
        headers: { cookie: adminCookie, origin },
      })
    );

    // The retry the failure leaves room for: the session is still there.
    expect(revoke.status).toBe(200);
    expect(await sessionIds(adminId)).not.toContain(other);
  });

  it("keeps every session when a module's statement fails on revoking them all", async () => {
    const before = await sessionIds(adminId);

    const failed = await hooks.call<{ error?: string }>(
      "revocation.revokeAccessWithFailingModule",
      adminId
    );

    expect(failed.error).toBeDefined();
    expect(before.length).toBeGreaterThan(0);
    expect(await sessionIds(adminId)).toEqual(before);
  });
});
