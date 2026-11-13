import { describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import { z } from "zod";

import { sessionCookie } from "./cookies.ts";
import { readJson } from "./json.ts";
import { env, hooks, mailbox, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

const mailboxList = z.object({
  mailboxes: z.array(z.looseObject({ id: z.string() })),
});

/**
 * Mail routes read the session and the mailbox access in one D1 batch
 * (`mailAccessCompanion`). These pin that the batch decides exactly what a
 * separate access query after authentication would.
 */

async function bootstrap() {
  const response = await worker.fetch(
    new Request("http://example.test/api/auth/mock/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    })
  );

  expect(response.status).toBe(200);

  const admin = await env.DB.prepare(
    "SELECT id FROM users WHERE role = 'admin'"
  ).first<{ id: string }>();

  return {
    domain: "example.test",
    adminId: required(admin, "the bootstrap creates an admin").id,
  };
}

async function createPerson(
  name: string,
  workspace: { domain: string; adminId: string }
) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userId = `usr_${suffix}`;
  const mailboxId = `mbx_${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, name, role, status) VALUES (?, ?, 'member', 'active')"
    ).bind(userId, name),
    env.DB.prepare(`
      INSERT INTO mailboxes (id, local_part, domain, display_name, owner_user_id, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      mailboxId,
      `person-${suffix}`,
      workspace.domain,
      name,
      userId,
      workspace.adminId,
      Date.now(),
      Date.now()
    ),
  ]);

  const login = await worker.fetch(
    new Request("http://example.test/api/auth/mock/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }),
    })
  );

  expect(login.status).toBe(200);

  return { userId, mailboxId, cookie: sessionCookie(login) };
}

function get(path: string, cookie: string) {
  return worker.fetch(
    new Request(`http://example.test${path}`, { headers: { cookie } })
  );
}

function d1Entries(response: Response) {
  return (response.headers.get("server-timing") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("d1;"));
}

describe("session and mailbox access in one D1 round trip", () => {
  it("authorizes mail routes exactly like separate session and access reads", async () => {
    const workspace = await bootstrap();
    const ada = await createPerson("Ada", workspace);
    const bob = await createPerson("Bob", workspace);

    const list = await get("/api/mail/mailboxes", ada.cookie);
    expect(list.status).toBe(200);

    const { mailboxes } = await readJson(list, mailboxList);

    expect(mailboxes.map((listed) => listed.id)).toEqual([ada.mailboxId]);
    // Only the session lookup reached D1: the list rode in its batch.
    expect(d1Entries(list)).toEqual([
      expect.stringContaining('desc="session"'),
    ]);

    const own = await get(
      `/api/mail/mailboxes/${ada.mailboxId}/folders`,
      ada.cookie
    );

    expect(own.status).toBe(200);
    expect(d1Entries(own)).toHaveLength(1);

    const ownList = await get(
      `/api/mail/conversations?mailboxId=${ada.mailboxId}&folder=inbox`,
      ada.cookie
    );

    expect(ownList.status).toBe(200);
    expect(d1Entries(ownList)).toHaveLength(1);

    // The batch path still knows exactly who is signed in.
    await mailbox(ada.mailboxId).seedMailbox(
      [],
      [
        {
          id: "msg_batch_identity",
          conversationId: "conv_batch_identity",
          direction: "incoming",
          fromJson: [{ address: "sender@example.net", name: null }],
          toJson: [{ address: "ada@example.test", name: null }],
          subject: "Identity",
          timelineAt: new Date(),
          transportState: "received",
        },
      ]
    );

    const read = await worker.fetch(
      new Request(
        `http://example.test/api/mail/messages/msg_batch_identity/read?mailboxId=${ada.mailboxId}`,
        {
          method: "PATCH",
          headers: { cookie: ada.cookie, "content-type": "application/json" },
          body: JSON.stringify({ isRead: true }),
        }
      )
    );

    expect(read.status).toBe(200);
    expect(
      await hooks.mailboxSql(
        ada.mailboxId,
        "SELECT user_id FROM email_read_states WHERE email_id = ?",
        "msg_batch_identity"
      )
    ).toEqual([{ user_id: ada.userId }]);

    // Another person's mailbox, by path and by query parameter: the batch
    // is scoped to Ada's own session token.
    expect(
      (await get(`/api/mail/mailboxes/${bob.mailboxId}/folders`, ada.cookie))
        .status
    ).toBe(403);
    expect(
      (
        await get(
          `/api/mail/conversations?mailboxId=${bob.mailboxId}&folder=inbox`,
          ada.cookie
        )
      ).status
    ).toBe(403);
    expect(
      (await get(`/api/mail/mailboxes/${ada.mailboxId}/folders`, bob.cookie))
        .status
    ).toBe(403);

    // Revoked access applies to the very next request.
    await env.DB.prepare("UPDATE mailboxes SET owner_user_id = ? WHERE id = ?")
      .bind(bob.userId, ada.mailboxId)
      .run();
    expect(
      (await get(`/api/mail/mailboxes/${ada.mailboxId}/folders`, ada.cookie))
        .status
    ).toBe(403);
    const afterRevoke = await get("/api/mail/mailboxes", ada.cookie);
    expect((await readJson(afterRevoke, mailboxList)).mailboxes).toEqual([]);
    expect(
      (await get(`/api/mail/mailboxes/${ada.mailboxId}/folders`, bob.cookie))
        .status
    ).toBe(200);

    // A disabled person and an expired session are signed out, not forbidden.
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?")
      .bind(bob.userId)
      .run();
    expect(
      (await get(`/api/mail/mailboxes/${bob.mailboxId}/folders`, bob.cookie))
        .status
    ).toBe(401);
    expect((await get("/api/mail/mailboxes", bob.cookie)).status).toBe(401);
    await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?")
      .bind(bob.userId)
      .run();
    expect(
      (await get(`/api/mail/mailboxes/${bob.mailboxId}/folders`, bob.cookie))
        .status
    ).toBe(200);
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?")
      .bind(Date.now() - 1000, bob.userId)
      .run();
    expect(
      (await get(`/api/mail/mailboxes/${bob.mailboxId}/folders`, bob.cookie))
        .status
    ).toBe(401);
    expect(
      (
        await get(
          `/api/mail/conversations?mailboxId=${bob.mailboxId}&folder=inbox`,
          bob.cookie
        )
      ).status
    ).toBe(401);
  });
});
