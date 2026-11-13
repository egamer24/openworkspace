import { beforeAll, describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import { mcpAccessToken } from "@open-workspace/core/testing";
import { z } from "zod";

import { MAX_IMPORT_MESSAGE_BYTES } from "../../shared/mail-import.ts";
import { jsonValue, readJson } from "./json.ts";
import type { JsonValue } from "./json.ts";
import { bootstrapAdmin } from "./mail-flow-helpers.ts";
import { env, hooks, mailbox, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

const origin = "http://example.test";
let adminCookie = "";
let memberCookie = "";
let memberId = "";
let adminMailboxId = "";
let memberMailboxId = "";
let teamMailboxId = "";

function cookieOf(response: Response) {
  return required(
    response.headers.get("set-cookie")?.split(";", 1)[0],
    "the response sets a session cookie"
  );
}

/** An import's answer (import-routes.ts): the stored message, or the one it duplicates. */
const importedBody = z.looseObject({
  ok: z.literal(true),
  duplicate: z.boolean(),
  id: z.string(),
  conversationId: z.string(),
  folderSkipped: z.enum(["limit", "invalid"]).nullable().optional(),
});

const idRow = z.object({ id: z.string() });

const versionRow = z.object({ version: z.number() });

const mailboxesBody = z.object({
  mailboxes: z.array(z.looseObject({ id: z.string() })),
});

function message(input: {
  id: string;
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  date?: string;
  inReplyTo?: string;
  extra?: string;
}) {
  return [
    `From: ${input.from ?? "Rosa Quill <rosa@fernhollow.example>"}`,
    `To: ${input.to ?? "admin@example.test"}`,
    `Subject: ${input.subject ?? `Note ${input.id}`}`,
    `Date: ${input.date ?? "Tue, 03 Mar 2026 10:00:00 +0000"}`,
    `Message-ID: <${input.id}@fernhollow.example>`,
    ...(input.inReplyTo
      ? [`In-Reply-To: <${input.inReplyTo}@fernhollow.example>`]
      : []),
    "Authentication-Results: mx.fernhollow.example; spf=pass smtp.mailfrom=fernhollow.example",
    ...(input.extra ? [input.extra] : []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    input.body ?? `Body of ${input.id}.`,
    "",
  ].join("\r\n");
}

type ImportOptions = {
  sourceId: string;
  placement?: string;
  folder?: string;
  seen?: boolean;
  thread?: string;
  receivedAt?: number;
  direction?: string;
};

function importRequest(
  auth: { cookie?: string; token?: string },
  mailboxId: string,
  raw: BodyInit,
  options: ImportOptions
) {
  const url = new URL(
    `${origin}/api/mail/import/mailboxes/${mailboxId}/messages`
  );

  url.searchParams.set("sourceId", options.sourceId);

  if (options.placement) url.searchParams.set("placement", options.placement);

  if (options.folder) url.searchParams.set("folder", options.folder);

  if (options.seen) url.searchParams.set("seen", "1");

  if (options.thread) url.searchParams.set("thread", options.thread);

  if (options.receivedAt) {
    url.searchParams.set("receivedAt", String(options.receivedAt));
  }

  if (options.direction) url.searchParams.set("direction", options.direction);

  const headers = new Headers({ "content-type": "message/rfc822" });

  if (auth.cookie) headers.set("cookie", auth.cookie);

  if (auth.token) headers.set("authorization", `Bearer ${auth.token}`);

  return worker.fetch(new Request(url, { method: "POST", headers, body: raw }));
}

async function imported(
  auth: { cookie?: string; token?: string },
  mailboxId: string,
  raw: string,
  options: ImportOptions
) {
  const response = await importRequest(auth, mailboxId, raw, options);
  const body = jsonValue.parse(await response.json());
  expect(response.status, JSON.stringify(body)).toBeLessThan(300);

  return { status: response.status, ...importedBody.parse(body) };
}

async function finish(cookie: string, mailboxId: string) {
  const response = await worker.fetch(
    new Request(`${origin}/api/mail/import/mailboxes/${mailboxId}/finish`, {
      method: "POST",
      headers: { cookie },
    })
  );

  expect(response.status).toBe(200);

  return readJson(response, versionRow);
}

/** A JSON API call that must succeed; its body, parsed with `schema`. */
async function api<S extends z.ZodType>(
  cookie: string,
  path: string,
  schema: S,
  init: { method?: string; json?: JsonValue } = {}
): Promise<z.output<S>> {
  const headers = new Headers({ cookie, origin });

  if (init.json !== undefined) headers.set("content-type", "application/json");

  const response = await worker.fetch(
    new Request(`${origin}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    })
  );

  const body = jsonValue.parse(await response.json());
  expect(
    response.status,
    `${init.method ?? "GET"} ${path}: ${JSON.stringify(body)}`
  ).toBeLessThan(300);

  return schema.parse(body);
}

beforeAll(async () => {
  adminCookie = await bootstrapAdmin();

  const invited = await api(
    adminCookie,
    "/api/admin/invitations",
    z.looseObject({ accessLink: z.looseObject({ userId: z.string() }) }),
    {
      method: "POST",
      json: { name: "Member", email: "member@example.test" },
    }
  );

  memberId = invited.accessLink.userId;
  await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?")
    .bind(memberId)
    .run();
  memberCookie = cookieOf(
    await worker.fetch(
      new Request(`${origin}/api/auth/mock/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: memberId }),
      })
    )
  );
  adminMailboxId = idRow.parse(
    await env.DB.prepare(
      "SELECT id FROM mailboxes WHERE local_part = 'admin'"
    ).first()
  ).id;
  memberMailboxId = idRow.parse(
    await env.DB.prepare("SELECT id FROM mailboxes WHERE owner_user_id = ?")
      .bind(memberId)
      .first()
  ).id;

  const team = await api(
    adminCookie,
    "/api/admin/teams",
    z.looseObject({
      teamId: z.string().optional(),
      team: z.looseObject({ id: z.string() }).optional(),
    }),
    {
      method: "POST",
      json: {
        name: "Support",
        slug: "support",
        description: null,
        members: [{ userId: memberId, canSend: true }],
      },
    }
  );

  const teamId =
    team.teamId ?? required(team.team, "the team is in the answer").id;

  teamMailboxId = (
    await api(
      adminCookie,
      "/api/admin/mailboxes",
      z.looseObject({ mailboxId: z.string() }),
      {
        method: "POST",
        json: {
          address: "support@example.test",
          displayName: "Support",
          ownerUserId: null,
          teamId,
        },
      }
    )
  ).mailboxId;
});

describe("mail import", () => {
  it("stores mail where the importer says, with read state, date and thread", async () => {
    const target = mailbox(adminMailboxId);
    await target.testFake({
      push: "capture",
      webhooks: "capture",
      classifier: { mode: "throw" },
    });

    const countsVersion = async () =>
      versionRow
        .nullable()
        .parse(
          await env.DB.prepare(
            "SELECT version FROM mailbox_counts WHERE mailbox_id = ?"
          )
            .bind(adminMailboxId)
            .first()
        )?.version ?? 0;

    const versionBefore = await countsVersion();

    // One Gmail thread, given out of order: the reply first.
    const reply = await imported(
      { cookie: adminCookie },
      adminMailboxId,
      message({
        id: "thread-2",
        subject: "Re: Lantern order",
        inReplyTo: "thread-1",
        body: "The lanterns ship on Friday.",
      }),
      {
        sourceId: "gmail:2",
        thread: "1001",
        placement: "inbox",
        folder: "Orders",
        receivedAt: Date.UTC(2026, 2, 4),
      }
    );

    const first = await imported(
      { cookie: adminCookie },
      adminMailboxId,
      message({
        id: "thread-1",
        subject: "Lantern order",
        body: "Could you send twelve brass lanterns?",
      }),
      {
        sourceId: "gmail:1",
        thread: "1001",
        placement: "archive",
        seen: true,
        receivedAt: Date.UTC(2026, 2, 3),
      }
    );

    expect(reply.status).toBe(201);
    expect(first.status).toBe(201);
    expect(first.conversationId).toBe(reply.conversationId);
    expect(reply.folderSkipped).toBeNull();

    // A sent message with no other place, and one in Trash and one in Spam.
    const sent = await imported(
      { cookie: adminCookie },
      adminMailboxId,
      message({
        id: "sent-1",
        from: "Admin <admin@example.test>",
        to: "rosa@fernhollow.example",
        subject: "Invoice",
      }),
      { sourceId: "gmail:3", placement: "sent" }
    );

    const trashed = await imported(
      { cookie: adminCookie },
      adminMailboxId,
      message({ id: "trash-1" }),
      {
        sourceId: "gmail:4",
        placement: "trash",
        seen: true,
      }
    );

    const spam = await imported(
      { cookie: adminCookie },
      adminMailboxId,
      message({ id: "spam-1" }),
      {
        sourceId: "gmail:5",
        placement: "spam",
      }
    );

    // "Sent" is a system folder's name, so it is no custom folder.
    const misnamed = await imported(
      { cookie: adminCookie },
      adminMailboxId,
      message({ id: "misnamed-1" }),
      {
        sourceId: "gmail:6",
        placement: "inbox",
        folder: "sent",
      }
    );

    expect(misnamed.folderSkipped).toBe("invalid");

    // Nothing is announced per message: D1's counts wait for the batch.
    expect(await countsVersion()).toBe(versionBefore);

    const rows = await hooks.mailboxRows(
      adminMailboxId,
      z.object({
        id: z.string(),
        direction: z.string(),
        transport_state: z.string(),
        timeline_at: z.number(),
        sender_intel_json: z.string().nullable(),
        ai_classification_json: z.string().nullable(),
        envelope_to: z.string().nullable(),
        mailbox_state: z.string(),
        folder: z.string().nullable(),
      }),
      `
      SELECT e.id, e.direction, e.transport_state, e.timeline_at, e.sender_intel_json, e.ai_classification_json,
        e.envelope_to, c.mailbox_state, f.name AS folder
      FROM emails e JOIN conversations c ON c.id = e.conversation_id LEFT JOIN folders f ON f.id = c.folder_id
      ORDER BY e.timeline_at`
    );

    const byId = new Map(rows.map((row) => [row.id, row]));
    // The thread's reply asks for the Orders folder, which outranks Archive.
    expect(byId.get(first.id)).toMatchObject({
      mailbox_state: "active",
      folder: "Orders",
      timeline_at: Date.UTC(2026, 2, 3),
    });
    expect(byId.get(reply.id)).toMatchObject({
      mailbox_state: "active",
      folder: "Orders",
      timeline_at: Date.UTC(2026, 2, 4),
    });
    expect(byId.get(sent.id)).toMatchObject({
      direction: "outgoing",
      transport_state: "submitted",
      mailbox_state: "active",
    });
    // Without receivedAt, the Date header.
    expect(
      required(byId.get(sent.id), "the sent message is stored").timeline_at
    ).toBe(Date.parse("Tue, 03 Mar 2026 10:00:00 +0000"));
    expect(byId.get(trashed.id)).toMatchObject({ mailbox_state: "trash" });
    expect(byId.get(spam.id)).toMatchObject({ mailbox_state: "spam" });
    expect(byId.get(misnamed.id)).toMatchObject({
      mailbox_state: "active",
      folder: null,
    });

    for (const row of rows) {
      expect(row.sender_intel_json).toBeNull();
      expect(row.ai_classification_json).toBeNull();
      expect(row.envelope_to).toBeNull();
    }

    const reads = await hooks.mailboxRows(
      adminMailboxId,
      z.object({ email_id: z.string() }),
      "SELECT email_id FROM email_read_states ORDER BY email_id"
    );

    expect(reads.map((row) => row.email_id).sort()).toEqual(
      [first.id, trashed.id].sort()
    );

    // The batch is announced once: inbox counts in D1 (the reply and misnamed are unread).
    const finished = await finish(adminCookie, adminMailboxId);
    expect(finished.version).toBeGreaterThan(0);

    const counts = await env.DB.prepare(
      "SELECT incoming_count, version FROM mailbox_counts WHERE mailbox_id = ?"
    )
      .bind(adminMailboxId)
      .first();

    expect(counts).toEqual({ incoming_count: 3, version: finished.version });

    const listed = await api(
      adminCookie,
      "/api/mail/mailboxes",
      z.object({
        mailboxes: z.array(
          z.looseObject({ id: z.string(), unreadCount: z.number() })
        ),
      })
    );

    expect(
      required(
        listed.mailboxes.find((entry) => entry.id === adminMailboxId),
        "the admin's mailbox is listed"
      ).unreadCount
    ).toBe(2);

    // Folders and search see it as any mail.
    const folders = await api(
      adminCookie,
      `/api/mail/mailboxes/${adminMailboxId}/folders`,
      z.object({ folders: z.array(z.looseObject({ name: z.string() })) })
    );

    expect(folders.folders.map((folder) => folder.name)).toContain("Orders");

    const search = await api(
      adminCookie,
      `/api/mail/conversations?mailboxId=${adminMailboxId}&folder=inbox&search=lanterns`,
      z.object({
        conversations: z.array(z.looseObject({ conversationId: z.string() })),
      })
    );

    expect(search.conversations.map((item) => item.conversationId)).toEqual([
      reply.conversationId,
    ]);

    const recipients = await hooks.mailboxRows(
      adminMailboxId,
      z.object({ address: z.string(), message_count: z.number() }),
      "SELECT address, message_count FROM senders WHERE address = 'rosa@fernhollow.example'"
    );

    expect(
      required(recipients[0], "the sender is recorded").message_count
    ).toBeGreaterThan(0);

    // No AI, no webhooks, no push.
    const calls = await target.testCalls();
    expect(
      calls.filter((call) =>
        /^(WEBHOOKS|PUSH_NOTIFICATIONS)\.|^classificationModel$/u.test(
          call.kind
        )
      )
    ).toEqual([]);
    await target.testFake({});
  });

  it("imports each message once, by source id and by Message-ID", async () => {
    const raw = message({ id: "once-1", subject: "Only once" });

    const created = await imported(
      { cookie: adminCookie },
      adminMailboxId,
      raw,
      { sourceId: "mbox:once" }
    );

    expect(created.status).toBe(201);

    const again = await imported({ cookie: adminCookie }, adminMailboxId, raw, {
      sourceId: "mbox:once",
    });

    expect(again).toMatchObject({
      status: 200,
      duplicate: true,
      id: created.id,
    });

    // The same message from another source (IMAP after Takeout).
    const elsewhere = await importRequest(
      { cookie: adminCookie },
      adminMailboxId,
      raw,
      { sourceId: "imap:once" }
    );

    expect(elsewhere.status).toBe(200);
    expect(await elsewhere.json()).toMatchObject({
      duplicate: true,
      id: created.id,
    });

    const [row] = await hooks.mailboxRows(
      adminMailboxId,
      z.object({ count: z.number() }),
      "SELECT count(*) AS count FROM emails WHERE message_id_header = '<once-1@fernhollow.example>'"
    );

    expect(required(row, "count(*) gives a row").count).toBe(1);
  });

  it("refuses oversized and empty messages", async () => {
    const tooBig = await importRequest(
      { cookie: adminCookie },
      adminMailboxId,
      new Uint8Array(MAX_IMPORT_MESSAGE_BYTES + 1),
      {
        sourceId: "mbox:big",
      }
    );

    expect(tooBig.status).toBe(413);
    expect(await tooBig.json()).toMatchObject({ error: { code: "TOO_LARGE" } });

    const empty = await importRequest(
      { cookie: adminCookie },
      adminMailboxId,
      "",
      { sourceId: "mbox:empty" }
    );

    expect(empty.status).toBe(400);
    await empty.body?.cancel();

    const noSource = await importRequest(
      { cookie: adminCookie },
      adminMailboxId,
      message({ id: "x" }),
      { sourceId: "" }
    );

    expect(noSource.status).toBe(400);
    await noSource.body?.cancel();
  });

  it("lets members import into their own personal mailboxes only", async () => {
    const own = await importRequest(
      { cookie: memberCookie },
      memberMailboxId,
      message({ id: "member-own", to: "member@example.test" }),
      {
        sourceId: "m:1",
      }
    );

    expect(own.status).toBe(201);
    await own.body?.cancel();

    await Promise.all(
      [adminMailboxId, teamMailboxId].map(async (mailboxId) => {
        const refused = await importRequest(
          { cookie: memberCookie },
          mailboxId,
          message({ id: `member-${mailboxId}` }),
          { sourceId: "m:2" }
        );

        expect(refused.status, mailboxId).toBe(403);
        await refused.body?.cancel();
      })
    );

    const listed = await api(
      memberCookie,
      "/api/mail/import/mailboxes",
      mailboxesBody
    );

    expect(listed.mailboxes.map((entry) => entry.id)).toEqual([
      memberMailboxId,
    ]);

    const all = await api(
      adminCookie,
      "/api/mail/import/mailboxes",
      mailboxesBody
    );

    expect(all.mailboxes.map((entry) => entry.id).sort()).toEqual(
      [adminMailboxId, memberMailboxId, teamMailboxId].sort()
    );

    // With the Import mail permission, any mailbox.
    await api(adminCookie, `/api/admin/users/${memberId}`, jsonValue, {
      method: "PATCH",
      json: { permissions: ["import_mail"] },
    });

    const team = await importRequest(
      { cookie: memberCookie },
      teamMailboxId,
      message({ id: "member-team", to: "support@example.test" }),
      {
        sourceId: "m:3",
        seen: true,
      }
    );

    expect(team.status).toBe(201);
    const { id } = await readJson(team, importedBody);

    // Read for everyone who can open the team mailbox.
    const reads = await hooks.mailboxRows(
      teamMailboxId,
      z.object({ user_id: z.string() }),
      "SELECT user_id FROM email_read_states WHERE email_id = ?",
      id
    );

    expect(reads.map((row) => row.user_id)).toEqual([memberId]);
    await api(adminCookie, `/api/admin/users/${memberId}`, jsonValue, {
      method: "PATCH",
      json: { permissions: [] },
    });
  });

  it("asks apps for mail.organize in their own mailboxes and admin.import_mail elsewhere", async () => {
    const organizer = await mcpAccessToken(adminCookie, {
      scope: "mail.organize",
    });

    const ownByApp = await importRequest(
      { token: organizer.accessToken },
      adminMailboxId,
      message({ id: "app-own" }),
      { sourceId: "app:1" }
    );

    expect(ownByApp.status).toBe(201);
    await ownByApp.body?.cancel();

    // An administrator's app without the import scope stays in their own mailboxes.
    const elsewhere = await importRequest(
      { token: organizer.accessToken },
      memberMailboxId,
      message({ id: "app-other" }),
      { sourceId: "app:2" }
    );

    expect(elsewhere.status).toBe(403);
    await elsewhere.body?.cancel();

    const importer = await mcpAccessToken(adminCookie, {
      scope: "admin.import_mail",
    });

    const anywhere = await importRequest(
      { token: importer.accessToken },
      memberMailboxId,
      message({ id: "app-other" }),
      { sourceId: "app:2" }
    );

    expect(anywhere.status).toBe(201);
    await anywhere.body?.cancel();

    const reader = await mcpAccessToken(adminCookie, { scope: "mail.read" });

    const refused = await importRequest(
      { token: reader.accessToken },
      adminMailboxId,
      message({ id: "app-read" }),
      { sourceId: "app:3" }
    );

    expect(refused.status).toBe(403);
    expect(refused.headers.get("www-authenticate")).toBe(
      'Bearer error="insufficient_scope", scope="mail.organize admin.import_mail"'
    );
    await refused.body?.cancel();

    // A member cannot grant admin.import_mail; mail.organize still reaches their own mailbox.
    const member = await mcpAccessToken(memberCookie, {
      scope: "mail.organize admin.import_mail",
    });

    expect(member.scope).toBe("mail.organize");

    const memberOwn = await importRequest(
      { token: member.accessToken },
      memberMailboxId,
      message({ id: "app-member" }),
      { sourceId: "app:4" }
    );

    expect(memberOwn.status).toBe(201);
    await memberOwn.body?.cancel();

    const memberElsewhere = await importRequest(
      { token: member.accessToken },
      adminMailboxId,
      message({ id: "app-member-2" }),
      { sourceId: "app:5" }
    );

    expect(memberElsewhere.status).toBe(403);
    await memberElsewhere.body?.cancel();
  });
});
