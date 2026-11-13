import { beforeAll, describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import { z } from "zod";

import { sessionCookie } from "./cookies.ts";
import { readJson } from "./json.ts";
import { drainInbound } from "./mail-flow-helpers.ts";
import { env, hooks, mailbox, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

const origin = "http://example.test";
let adminCookie = "";
let adminId = "";
let leadId = "";
let otherId = "";
let leadCookie = "";

const invitationBody = z.object({
  accessLink: z.looseObject({ userId: z.string() }),
});

const createdMailbox = z.looseObject({ mailboxId: z.string() });
const createdTeam = z.looseObject({ teamId: z.string() });

const mailboxList = z.object({
  mailboxes: z.array(z.looseObject({ id: z.string() })),
});

const conversationList = z.object({
  conversations: z.array(
    z.looseObject({ conversationId: z.string(), subject: z.string() })
  ),
});

const adminState = z.object({
  teams: z.array(z.looseObject({ id: z.string(), everyone: z.boolean() })),
});

function call(
  cookie: string,
  path: string,
  init: { method?: string; json?: unknown } = {}
) {
  const headers = new Headers({ cookie, origin });

  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
  }

  return worker.fetch(
    new Request(`${origin}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    })
  );
}

async function invite(name: string, email: string) {
  const response = await call(adminCookie, "/api/admin/invitations", {
    method: "POST",
    json: { name, email },
  });

  expect(response.status).toBe(201);

  const { accessLink } = await readJson(response, invitationBody);

  await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?")
    .bind(accessLink.userId)
    .run();

  return accessLink.userId;
}

async function primaryMailboxId(userId: string) {
  const row = await env.DB.prepare(
    "SELECT id FROM mailboxes WHERE owner_user_id = ? AND is_primary = 1"
  )
    .bind(userId)
    .first<{ id: string }>();

  return required(row, `${userId} has a primary mailbox`).id;
}

/** A message as Cloudflare Email Routing hands it over, optionally DMARC-verified. */
function rawMessage(input: {
  from: string;
  to: string;
  messageId: string;
  verified?: boolean;
}) {
  const domain = input.from.split("@")[1];

  return [
    `Received: from mail.${domain} (192.0.2.10)`,
    `        by cloudflare-email.net (cloudflare) id ${crypto.randomUUID().slice(0, 12)}`,
    `        for <${input.to}>; Sat, 31 Oct 2026 10:00:00 +0000`,
    ...(input.verified
      ? [
          `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=${domain} policy.dmarc=reject; spf=pass smtp.mailfrom=${input.from}`,
        ]
      : [
          `Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=${domain} policy.dmarc=none; spf=fail smtp.mailfrom=${input.from}`,
        ]),
    `From: Sender <${input.from}>`,
    `To: ${input.to}`,
    `Subject: List post ${input.messageId}`,
    `Message-ID: <${input.messageId}>`,
    "",
    "Hello list.",
  ].join("\r\n");
}

async function deliver(input: {
  from: string;
  to: string;
  messageId: string;
  verified?: boolean;
}) {
  const { rejection } = await hooks.email({
    from: input.from,
    to: input.to,
    raw: rawMessage(input),
  });

  return rejection;
}

async function received(userId: string, messageId: string) {
  const mailboxId = await primaryMailboxId(userId);
  await drainInbound(mailboxId);

  return mailbox(mailboxId).getEmailByMessageId(`<${messageId}>`);
}

async function createList(
  teamId: string,
  localPart: string,
  listPosting: string
) {
  const response = await call(adminCookie, "/api/admin/mailboxes", {
    method: "POST",
    json: {
      address: `${localPart}@example.test`,
      displayName: localPart,
      ownerUserId: null,
      teamId,
      delivery: "list",
      listPosting,
    },
  });

  expect(response.status).toBe(201);

  return (await readJson(response, createdMailbox)).mailboxId;
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

  const admin = await env.DB.prepare(
    "SELECT id FROM users WHERE role = 'admin'"
  ).first<{ id: string }>();

  adminId = required(admin, "the bootstrap creates an admin").id;
  leadId = await invite("Lead", "lead@example.test");
  otherId = await invite("Other", "other@example.test");

  const login = await worker.fetch(
    new Request(`${origin}/api/auth/mock/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: leadId }),
    })
  );

  leadCookie = sessionCookie(login);
  await login.json();
});

describe("team mailing lists", () => {
  let teamId = "";

  beforeAll(async () => {
    const team = await call(adminCookie, "/api/admin/teams", {
      method: "POST",
      json: {
        name: "Design",
        slug: "design",
        description: null,
        members: [
          { userId: adminId, canSend: true },
          { userId: leadId, canSend: false },
        ],
      },
    });

    expect(team.status).toBe(201);
    teamId = (await readJson(team, createdTeam)).teamId;
  });

  it("copies mail into each member's own mailbox, once, marked with the list", async () => {
    const listId = await createList(teamId, "design", "anyone");
    const mailboxes = await call(leadCookie, "/api/mail/mailboxes");

    const { mailboxes: visible } = await readJson(mailboxes, mailboxList);

    expect(visible.map((entry) => entry.id)).not.toContain(listId);

    // The same message reaches the lead directly and through the list.
    expect(
      await deliver({
        from: "client@example.net",
        to: "design@example.test",
        messageId: "post-1@example.net",
      })
    ).toBeUndefined();
    expect(
      await deliver({
        from: "client@example.net",
        to: "lead@example.test",
        messageId: "post-1@example.net",
      })
    ).toBeUndefined();

    expect(await received(adminId, "post-1@example.net")).toMatchObject({
      listId: "design.example.test",
      listPostAddress: "design@example.test",
      envelopeTo: "design@example.test",
    });
    expect(await received(leadId, "post-1@example.net")).toMatchObject({
      listId: "design.example.test",
    });
    expect(await received(otherId, "post-1@example.net")).toBeNull();

    const leadMailbox = await primaryMailboxId(leadId);

    const list = await call(
      leadCookie,
      `/api/mail/conversations?mailboxId=${leadMailbox}&folder=inbox`
    );

    const { conversations } = await readJson(list, conversationList);

    const copies = conversations.filter((conversation) =>
      conversation.subject.includes("post-1@example.net")
    );

    expect(copies).toHaveLength(1);
    const [copy] = copies;

    const detail = await call(
      leadCookie,
      `/api/mail/conversations/${required(copy, "the list copy is listed").conversationId}?mailboxId=${leadMailbox}`
    );

    expect(await detail.json()).toMatchObject({
      messages: [{ viaList: "design@example.test" }],
    });
  });

  it("only takes verified mail from the workspace", async () => {
    await createList(teamId, "design-internal", "workspace");
    expect(
      await deliver({
        from: "client@example.net",
        to: "design-internal@example.test",
        messageId: "post-2@example.net",
        verified: true,
      })
    ).toContain("not allowed to post");
    // A forged workspace From without passing DMARC is still an outsider.
    expect(
      await deliver({
        from: "other@example.test",
        to: "design-internal@example.test",
        messageId: "post-3@example.test",
      })
    ).toContain("not allowed to post");
    expect(
      await deliver({
        from: "other@example.test",
        to: "design-internal@example.test",
        messageId: "post-4@example.test",
        verified: true,
      })
    ).toBeUndefined();
    expect(await received(leadId, "post-4@example.test")).not.toBeNull();
  });

  it("can be limited to the team's own members", async () => {
    await createList(teamId, "design-team", "members");
    expect(
      await deliver({
        from: "other@example.test",
        to: "design-team@example.test",
        messageId: "post-5@example.test",
        verified: true,
      })
    ).toContain("not allowed to post");
    expect(
      await deliver({
        from: "admin@example.test",
        to: "design-team@example.test",
        messageId: "post-6@example.test",
        verified: true,
      })
    ).toBeUndefined();
    expect(await received(leadId, "post-6@example.test")).not.toBeNull();
  });

  it("does not hand a member back a copy of their own post", async () => {
    const adminMailbox = mailbox(await primaryMailboxId(adminId));
    await adminMailbox.insertEmail({
      id: "msg_own_post",
      conversationId: "conv_own_post",
      direction: "outgoing",
      messageIdHeader: "<own-post@example.test>",
      fromJson: [{ address: "admin@example.test", name: null }],
      toJson: [{ address: "design@example.test", name: null }],
      subject: "Own post",
      timelineAt: new Date(),
      transportState: "submitted",
    });
    expect(
      await deliver({
        from: "admin@example.test",
        to: "design@example.test",
        messageId: "own-post@example.test",
        verified: true,
      })
    ).toBeUndefined();
    expect(await received(adminId, "own-post@example.test")).toMatchObject({
      direction: "outgoing",
    });
    expect(await received(leadId, "own-post@example.test")).toMatchObject({
      direction: "incoming",
    });
  });
});

describe("the everyone team", () => {
  it("includes every active person and nobody disabled", async () => {
    // The first administrator's sign-up creates the Everyone team.
    const teamId = "team_everyone";
    await createList(teamId, "all", "workspace");

    const disable = await call(adminCookie, `/api/admin/users/${otherId}`, {
      method: "PATCH",
      json: { status: "disabled" },
    });

    expect(disable.status).toBe(200);
    await disable.json();

    expect(
      await deliver({
        from: "lead@example.test",
        to: "all@example.test",
        messageId: "all-1@example.test",
        verified: true,
      })
    ).toBeUndefined();
    expect(await received(adminId, "all-1@example.test")).toMatchObject({
      listId: "all.example.test",
    });
    expect(await received(leadId, "all-1@example.test")).not.toBeNull();
    expect(await received(otherId, "all-1@example.test")).toBeNull();

    const state = await call(adminCookie, "/api/admin/state");

    const body = await readJson(state, adminState);

    expect(
      body.teams.find((candidate) => candidate.id === teamId)
    ).toMatchObject({ everyone: true });
  });
});
