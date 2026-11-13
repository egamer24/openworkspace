import { beforeAll, describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import { z } from "zod";

import { sessionCookie } from "./cookies.ts";
import { readJson } from "./json.ts";
import { env, hooks, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

/** The signed-in admin and their mailbox, as the directory queries see them. */
type Directory = {
  mailboxId: string;
  sessionId: string;
  userId: string;
  userName: string;
};

const mailboxList = z.object({
  mailboxes: z.array(z.looseObject({ id: z.string() })),
});

let directory: Directory;

beforeAll(async () => {
  const userName = "Directory Admin";

  const bootstrap = await worker.fetch(
    new Request("http://example.test/api/auth/mock/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: userName,
        email: "directory-admin@example.test",
      }),
    })
  );

  expect(bootstrap.status).toBe(200);
  const cookie = sessionCookie(bootstrap);
  await bootstrap.json();

  const mailboxes = await worker.fetch(
    new Request("http://example.test/api/mail/mailboxes", {
      headers: { cookie },
    })
  );

  const [first] = (await readJson(mailboxes, mailboxList)).mailboxes;
  const mailboxId = required(first, "the admin has a mailbox").id;

  const stored = await env.DB.prepare(`
    select session.id as session_id, session.user_id
    from sessions session
    inner join mailbox_access member on member.user_id = session.user_id
    where member.mailbox_id = ?
    limit 1
  `)
    .bind(mailboxId)
    .first<{ session_id: string; user_id: string }>();

  const session = required(stored, "the admin's session reaches the mailbox");
  directory = {
    mailboxId,
    sessionId: session.session_id,
    userId: session.user_id,
    userName,
  };
});

describe("mailbox D1 directory queries", () => {
  it("accepts session and user ID sets larger than the D1 parameter limit", async () => {
    const missingIds = Array.from(
      { length: 150 },
      (_, index) => `missing_${index}`
    );

    // The queries run in the Worker, against its D1.
    await expect(
      hooks.call(
        "realtime.listActiveMailboxSessions",
        directory.mailboxId,
        [...missingIds, directory.sessionId],
        Date.now()
      )
    ).resolves.toEqual([
      {
        id: directory.sessionId,
        tokenHash: expect.any(String),
        userId: directory.userId,
      },
    ]);
    await expect(
      hooks.call("realtime.listMailboxUsersByIds", directory.mailboxId, [
        ...missingIds,
        directory.userId,
      ])
    ).resolves.toEqual([
      {
        id: directory.userId,
        name: directory.userName,
      },
    ]);
  });
});
