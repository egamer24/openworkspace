import { describe, expect, it } from "bun:test";

import { hashToken, randomToken } from "@open-workspace/core/module";
import { required } from "@open-workspace/core/shared";
import { z } from "zod";

import { sessionCookie } from "./cookies.ts";
import { env, mailbox, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

const issuer = "http://example.test";

/** The JSON body of a successful response, parsed with `schema`. */
async function body<S extends z.ZodType>(response: Response, schema: S) {
  const value: unknown = await response.json();
  expect(response.status, JSON.stringify(value)).toBeLessThan(400);

  return schema.parse(value);
}

/** A body the test only needs to be a success. */
const anyBody = z.unknown();

describe("OIDC user lifecycle", () => {
  it("revokes browser and OIDC access when an admin disables a user", async () => {
    const bootstrap = await worker.fetch(
      new Request(`${issuer}/api/auth/mock/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Lifecycle Admin",
          email: "lifecycle-admin@example.test",
        }),
      })
    );

    const adminCookie = sessionCookie(bootstrap);
    await body(bootstrap, anyBody);

    const invitation = await body(
      await worker.fetch(
        new Request(`${issuer}/api/admin/invitations`, {
          method: "POST",
          headers: {
            cookie: adminCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Lifecycle User",
            email: "lifecycle-user@example.test",
          }),
        })
      ),
      z.object({ accessLink: z.looseObject({ userId: z.string() }) })
    );

    const { userId } = invitation.accessLink;
    await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?")
      .bind(userId)
      .run();

    const login = await worker.fetch(
      new Request(`${issuer}/api/auth/mock/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      })
    );

    const userCookie = sessionCookie(login);
    await body(login, anyBody);

    const mailboxList = await body(
      await worker.fetch(
        new Request(`${issuer}/api/mail/mailboxes`, {
          headers: { cookie: userCookie },
        })
      ),
      z.object({ mailboxes: z.array(z.looseObject({ id: z.string() })) })
    );

    const [firstMailbox] = mailboxList.mailboxes;
    const mailboxId = required(firstMailbox, "the user has a mailbox").id;
    const realtimeMessageId = `msg_lifecycle_${crypto.randomUUID()}`;
    const mailboxObject = mailbox(mailboxId);
    await mailboxObject.seedMailbox(
      [],
      [
        {
          id: realtimeMessageId,
          conversationId: `conv_lifecycle_${crypto.randomUUID()}`,
          direction: "incoming",
          fromJson: [{ address: "sender@example.net", name: "Sender" }],
          toJson: [
            { address: "lifecycle-user@example.test", name: "Lifecycle User" },
          ],
          subject: "Lifecycle realtime authorization",
          timelineAt: new Date(),
          transportState: "received",
        },
      ]
    );

    // A real WebSocket to the deployed Worker, as the browser opens it.
    const realtimeUrl = new URL(
      `/api/mail/mailboxes/${mailboxId}/realtime`,
      process.env.STACK_URL
    );

    realtimeUrl.protocol = "ws:";

    const socket = new WebSocket(realtimeUrl, {
      // @ts-expect-error Bun's WebSocket takes request headers; the DOM lib's constructor type does not.
      headers: { cookie: userCookie, origin: issuer, host: "example.test" },
    });

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Realtime WebSocket did not open")),
        { once: true }
      );
    });

    const socketClosed = new Promise<number>((resolve) => {
      socket.addEventListener("close", (event) => resolve(event.code), {
        once: true,
      });
    });

    const userSession = await env.DB.prepare(
      `SELECT session.id
       FROM sessions session
       WHERE session.user_id = ? LIMIT 1`
    )
      .bind(userId)
      .first<{ id: string }>();

    expect(userSession).toBeTruthy();
    const pushSubscriptionId = `push_${crypto.randomUUID()}`;
    await env.DB.prepare(`
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
      VALUES (?, ?, ?, ?, ?)
    `)
      .bind(
        pushSubscriptionId,
        userId,
        `https://push.example.test/${crypto.randomUUID()}`,
        "test-p256dh",
        "test-auth"
      )
      .run();

    const client = await body(
      await worker.fetch(
        new Request(`${issuer}/api/admin/oidc-clients`, {
          method: "POST",
          headers: {
            cookie: adminCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Lifecycle app",
            clientType: "public",
            accessTeams: [{ teamId: "team_everyone" }],
            redirectUris: ["https://lifecycle.example.test/callback"],
            postLogoutRedirectUris: [],
            allowedOrigins: [],
            allowedScopes: ["openid", "email"],
            trusted: true,
            enabled: true,
          }),
        })
      ),
      z.looseObject({ clientId: z.string() })
    );

    const verifier = randomToken(48);
    const authorize = new URL(`${issuer}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: "https://lifecycle.example.test/callback",
      scope: "openid email",
      code_challenge: await hashToken(verifier),
      code_challenge_method: "S256",
    }).toString();

    const authorization = await worker.fetch(
      new Request(authorize, {
        headers: { cookie: userCookie },
        redirect: "manual",
      })
    );

    const code = required(
      new URL(
        required(
          authorization.headers.get("location"),
          "the authorization redirects back"
        )
      ).searchParams.get("code"),
      "the redirect carries a code"
    );

    const tokens = await body(
      await worker.fetch(
        new Request(`${issuer}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: client.clientId,
            code,
            redirect_uri: "https://lifecycle.example.test/callback",
            code_verifier: verifier,
          }),
        })
      ),
      z.looseObject({ access_token: z.string() })
    );

    const recovery = await body(
      await worker.fetch(
        new Request(`${issuer}/api/admin/users/${userId}/access-link`, {
          method: "POST",
          headers: { cookie: adminCookie },
        })
      ),
      z.object({ accessLink: z.looseObject({ url: z.string() }) })
    );

    await body(
      await worker.fetch(
        new Request(`${issuer}/api/admin/users/${userId}`, {
          method: "PATCH",
          headers: {
            cookie: adminCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Lifecycle User",
            status: "disabled",
          }),
        })
      ),
      anyBody
    );
    expect(
      await mailboxObject.setMessageRead(userId, realtimeMessageId, true)
    ).toEqual({ version: expect.any(Number) });
    await expect(socketClosed).resolves.toBe(1008);

    const remainingPushSubscriptions = await env.DB.prepare(
      "SELECT count(*) AS count FROM push_subscriptions WHERE id = ?"
    )
      .bind(pushSubscriptionId)
      .first<{ count: number }>();

    expect(remainingPushSubscriptions?.count).toBe(0);

    const authState = await body(
      await worker.fetch(
        new Request(`${issuer}/api/bootstrap`, {
          headers: { cookie: userCookie },
        })
      ),
      z.looseObject({ authenticated: z.boolean() })
    );

    expect(authState.authenticated).toBe(false);

    const userinfo = await worker.fetch(
      new Request(`${issuer}/oauth/userinfo`, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      })
    );

    expect(userinfo.status).toBe(401);

    const recoveryPreview = await worker.fetch(
      new URL(recovery.accessLink.url).pathname.replace(
        "/recover/",
        `${issuer}/api/auth/recovery/`
      )
    );

    expect(recoveryPreview.status).toBe(404);

    const disabledRecovery = await worker.fetch(
      new Request(`${issuer}/api/admin/users/${userId}/access-link`, {
        method: "POST",
        headers: { cookie: adminCookie },
      })
    );

    expect(disabledRecovery.status).toBe(400);
    const silent = new URL(authorize);
    silent.searchParams.set("prompt", "none");

    const denied = await worker.fetch(
      new Request(silent, {
        headers: { cookie: userCookie },
        redirect: "manual",
      })
    );

    expect(
      new URL(
        required(denied.headers.get("location"), "the silent login redirects")
      ).searchParams.get("error")
    ).toBe("login_required");
  });
});
