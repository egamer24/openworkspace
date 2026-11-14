import { beforeAll, describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import { z } from "zod";

import { sessionCookie } from "./cookies.ts";
import { readJson } from "./json.ts";
import { drainInbound } from "./mail-flow-helpers.ts";
import { pollUntil } from "./poll.ts";
import { env, hooks, mailbox, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

const origin = "http://example.test";
let adminCookie = "";
let adminId = "";
let primaryId = "";
let memberCookie = "";
let memberMailboxId = "";
let teamId = "";
let teamInboxId = "";
let aliasId = "";

function call(
  cookie: string,
  path: string,
  init: { method?: string; json?: unknown } = {}
) {
  const headers = new Headers({ cookie, origin });

  if (init.json !== undefined) headers.set("content-type", "application/json");

  return worker.fetch(
    new Request(`${origin}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    })
  );
}

type AddressInput = {
  address: string;
  displayName: string;
  ownerUserId: string | null;
  teamId: string | null;
  delivery: "inbox" | "list" | "alias";
  aliasOf?: string;
  listPosting?: "anyone" | "workspace";
};

type AutoReplyMessageBody = { enabled: boolean; html: string; text: string };

type AutoReplyBody = {
  enabled: boolean;
  startsAt?: string;
  endsAt?: string;
  inside: AutoReplyMessageBody;
  outside: AutoReplyMessageBody;
};

async function createAddress(json: AddressInput) {
  const response = await call(adminCookie, "/api/admin/mailboxes", {
    method: "POST",
    json: { listPosting: "workspace", ...json },
  });

  expect(response.status).toBe(201);

  return (await readJson(response, z.looseObject({ mailboxId: z.string() })))
    .mailboxId;
}

/** Uploads `bytes` as a PNG through the composer's upload flow; its upload id. */
async function uploadImage(cookie: string, mailboxId: string, bytes: string) {
  const intent = await readJson(
    await call(cookie, `/api/mail/uploads?mailboxId=${mailboxId}`, {
      method: "POST",
      json: {
        filename: "away.png",
        contentType: "image/png",
        size: bytes.length,
      },
    }),
    z.looseObject({
      upload: z.looseObject({
        id: z.string(),
        uploadUrl: z.string(),
        headers: z.record(z.string(), z.string()),
      }),
    })
  );

  const put = await fetch(intent.upload.uploadUrl, {
    method: "PUT",
    headers: intent.upload.headers,
    body: bytes,
  });

  expect(put.status).toBe(200);
  await put.arrayBuffer();

  const complete = await call(
    cookie,
    `/api/mail/uploads/${intent.upload.id}/complete?mailboxId=${mailboxId}`,
    { method: "POST" }
  );

  expect(complete.status).toBe(200);
  await complete.json();

  return intent.upload.id;
}

const message = (text: string, enabled = true) => ({
  enabled,
  html: `<p>${text}</p>`,
  text,
});

/** Mail as Email Routing hands it over, through the real inbound route. */
async function deliver(input: {
  from: string;
  to: string;
  id: string;
  headers?: string[];
}) {
  const domain = input.from.split("@")[1];

  const { rejection } = await hooks.email({
    from: input.from,
    to: input.to,
    raw: [
      `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=${domain}; spf=pass smtp.mailfrom=${input.from}`,
      `From: <${input.from}>`,
      `To: ${input.to}`,
      "Subject: Are you around?",
      `Message-ID: <${input.id}>`,
      ...(input.headers ?? []),
      "",
      "Hello",
    ].join("\r\n"),
  });

  expect(rejection).toBeUndefined();
  await drainInbound(primaryId);
}

const logRow = z.object({
  sender_address: z.string(),
  last_outbound_message_id: z.string().nullable(),
});

function answered(mailboxId: string) {
  return hooks.mailboxRows(
    mailboxId,
    logRow,
    "SELECT sender_address, last_outbound_message_id FROM auto_reply_log ORDER BY sender_address"
  );
}

/** Waits until `senders` were each answered (Email Sending gave a Message-ID). */
async function answeredSenders(senders: string[]) {
  return required(
    await pollUntil(
      async () => {
        const rows = await answered(primaryId);

        return senders.every((sender) =>
          rows.some(
            (row) =>
              row.sender_address === sender && row.last_outbound_message_id
          )
        )
          ? rows.map((row) => row.sender_address)
          : null;
      },
      { failure: `${senders.join(", ")} got no auto-reply` }
    ),
    "the replies went out"
  );
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

  adminId = required(
    await env.DB.prepare("SELECT id FROM users WHERE role = 'admin'").first<{
      id: string;
    }>(),
    "the bootstrap creates an admin"
  ).id;

  primaryId = required(
    await env.DB.prepare(
      "SELECT id FROM mailboxes WHERE owner_user_id = ? AND is_primary = 1"
    )
      .bind(adminId)
      .first<{ id: string }>(),
    "the admin has a primary mailbox"
  ).id;

  const invitation = await call(adminCookie, "/api/admin/invitations", {
    method: "POST",
    json: { name: "Member", email: "member@example.test" },
  });

  expect(invitation.status).toBe(201);

  const { accessLink } = await readJson(
    invitation,
    z.looseObject({ accessLink: z.looseObject({ userId: z.string() }) })
  );

  await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?")
    .bind(accessLink.userId)
    .run();

  const login = await worker.fetch(
    new Request(`${origin}/api/auth/mock/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: accessLink.userId }),
    })
  );

  memberCookie = sessionCookie(login);
  await login.json();

  memberMailboxId = required(
    await env.DB.prepare(
      "SELECT id FROM mailboxes WHERE owner_user_id = ? AND is_primary = 1"
    )
      .bind(accessLink.userId)
      .first<{ id: string }>(),
    "the member has a primary mailbox"
  ).id;

  const team = await call(adminCookie, "/api/admin/teams", {
    method: "POST",
    json: {
      name: "Support",
      slug: "support",
      description: null,
      members: [{ userId: adminId, canSend: true }],
    },
  });

  expect(team.status).toBe(201);
  teamId = (await readJson(team, z.looseObject({ teamId: z.string() }))).teamId;

  teamInboxId = await createAddress({
    address: "support@example.test",
    displayName: "Support",
    ownerUserId: null,
    teamId,
    delivery: "inbox",
  });

  aliasId = await createAddress({
    address: "billing@example.test",
    displayName: "Billing",
    ownerUserId: adminId,
    teamId: null,
    delivery: "alias",
    aliasOf: primaryId,
  });
});

describe("auto-replies", () => {
  it("are for an address's owner, People and Teams admins, and only mailboxes", async () => {
    const own = await readJson(
      await call(memberCookie, "/api/mail/auto-replies"),
      z.object({ mailboxes: z.array(z.looseObject({ id: z.string() })) })
    );

    // Settings lists the member's own mailbox, not team inboxes.
    expect(own.mailboxes.map((row) => row.id)).toEqual([memberMailboxId]);

    const statuses = (cookie: string, ids: string[]) =>
      Promise.all(
        ids.map(async (id) => {
          const response = await call(
            cookie,
            `/api/mail/mailboxes/${id}/auto-reply`
          );

          await response.json();

          return response.status;
        })
      );

    expect(
      await statuses(memberCookie, [
        memberMailboxId,
        primaryId,
        teamInboxId,
        aliasId,
      ])
    ).toEqual([200, 403, 403, 404]);

    // The admin manages people and teams.
    expect(await statuses(adminCookie, [memberMailboxId, teamInboxId])).toEqual(
      [200, 200]
    );

    const forbidden = await call(
      memberCookie,
      `/api/mail/mailboxes/${teamInboxId}/auto-reply`,
      {
        method: "PUT",
        json: {
          enabled: true,
          inside: message("Away"),
          outside: message("Away"),
        },
      }
    );

    expect(forbidden.status).toBe(403);
    await forbidden.json();
  });

  it("skip mail that went to Spam", async () => {
    const on = await call(
      adminCookie,
      `/api/mail/mailboxes/${primaryId}/auto-reply`,
      {
        method: "PUT",
        json: {
          enabled: true,
          inside: message("In the office soon"),
          outside: message("Away until Monday"),
        },
      }
    );

    expect(on.status).toBe(200);
    await on.json();

    await mailbox(primaryId).blockSender("zed@outside.test", false);
    await deliver({
      from: "zed@outside.test",
      to: "admin@example.test",
      id: "zed-1@outside.test",
    });

    const blocked = required(
      await mailbox(primaryId).getEmailByMessageId("<zed-1@outside.test>"),
      "zed's message arrived"
    );

    const [conversation] = await hooks.mailboxSql(
      primaryId,
      "SELECT mailbox_state FROM conversations WHERE id = ?",
      blocked.conversationId
    );

    expect(conversation).toEqual({ mailbox_state: "spam" });
    // Given time to run, it still sent nothing.
    await Bun.sleep(300);
    expect(await answered(primaryId)).toEqual([]);
  });

  it("answer by delivery: direct, alias, plus address and catch-all, not list copies", async () => {
    const refused = (json: AutoReplyBody) =>
      call(adminCookie, `/api/mail/mailboxes/${primaryId}/auto-reply`, {
        method: "PUT",
        json,
      }).then(async (response) => {
        await response.json();

        return response.status;
      });

    // On without a message, with both off, or ending before it starts.
    expect(
      await refused({
        enabled: true,
        inside: message("", true),
        outside: message("Away"),
      })
    ).toBe(400);
    expect(
      await refused({
        enabled: true,
        inside: message("Hi", false),
        outside: message("Away", false),
      })
    ).toBe(400);
    expect(
      await refused({
        enabled: true,
        startsAt: "2026-06-10T00:00:00Z",
        endsAt: "2026-06-01T00:00:00Z",
        inside: message("Hi"),
        outside: message("Away"),
      })
    ).toBe(400);

    const imageId = "away@openworkspace.local";
    const upload = await uploadImage(adminCookie, primaryId, "away-png");

    const saved = await call(
      adminCookie,
      `/api/mail/mailboxes/${primaryId}/auto-reply`,
      {
        method: "PUT",
        json: {
          enabled: true,
          inside: message("In the office soon", false),
          outside: {
            ...message("Away until Monday"),
            html: `<p>Away until Monday</p><img src="cid:${imageId}">`,
            images: [{ uploadId: upload, contentId: imageId }],
            uploadMailboxId: primaryId,
          },
        },
      }
    );

    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      status: "active",
      settings: {
        enabled: true,
        replyIntervalDays: 4,
        inside: { enabled: false },
        outside: {
          enabled: true,
          audience: "everyone",
          images: [{ contentId: imageId, contentType: "image/png" }],
        },
      },
    });

    const image = await call(
      adminCookie,
      `/api/mail/mailboxes/${primaryId}/auto-reply/images/${encodeURIComponent(imageId)}`
    );

    expect(image.status).toBe(200);
    expect(await image.text()).toBe("away-png");

    // Make the admin's mailbox the domain's catch-all.
    const catchAll = await call(
      adminCookie,
      `/api/admin/mailboxes/${primaryId}`,
      { method: "PATCH", json: { displayName: "Admin", catchAll: true } }
    );

    expect(catchAll.status).toBe(200);
    await catchAll.json();

    const list = await createAddress({
      address: "design@example.test",
      displayName: "Design",
      ownerUserId: null,
      teamId,
      delivery: "list",
      listPosting: "anyone",
    });

    expect(list).toBeTruthy();

    await deliver({
      from: "ana@outside.test",
      to: "admin@example.test",
      id: "a@x",
    });
    await deliver({
      from: "bob@outside.test",
      to: "billing@example.test",
      id: "b@x",
    });
    await deliver({
      from: "cy@outside.test",
      to: "admin+shop@example.test",
      id: "c@x",
    });
    await deliver({
      from: "di@outside.test",
      to: "nobody@example.test",
      id: "d@x",
    });
    // A copy of a workspace list's post, a list from elsewhere, and a
    // colleague while the inside message is off.
    await deliver({
      from: "eve@outside.test",
      to: "design@example.test",
      id: "e@x",
    });
    await deliver({
      from: "fay@outside.test",
      to: "admin@example.test",
      id: "f@x",
      headers: ["List-Id: <news.outside.test>"],
    });
    await deliver({
      from: "member@example.test",
      to: "admin@example.test",
      id: "g@x",
    });

    expect(await mailbox(primaryId).getEmailByMessageId("<e@x>")).toMatchObject(
      { listPostAddress: "design@example.test" }
    );

    expect(
      await answeredSenders([
        "ana@outside.test",
        "bob@outside.test",
        "cy@outside.test",
        "di@outside.test",
      ])
    ).toEqual([
      "ana@outside.test",
      "bob@outside.test",
      "cy@outside.test",
      "di@outside.test",
    ]);

    // Another message from Ana within the interval, however she spells her
    // address, gets no second reply.
    const before = await answered(primaryId);

    await deliver({
      from: "Ana@outside.test",
      to: "admin@example.test",
      id: "a2@x",
    });
    await Bun.sleep(300);
    expect(await answered(primaryId)).toEqual(before);

    // The banner's Turn off keeps the messages.
    const off = await call(
      adminCookie,
      `/api/mail/mailboxes/${primaryId}/auto-reply`,
      { method: "PATCH", json: { enabled: false } }
    );

    expect(await off.json()).toMatchObject({
      status: "off",
      settings: { outside: { html: expect.stringContaining("Away") } },
    });
  });
});
