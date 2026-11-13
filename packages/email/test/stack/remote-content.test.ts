import { beforeAll, describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import { internet, poll } from "@open-workspace/core/testing";
import { REMOTE_TOKEN_WINDOW_MS } from "@open-workspace/email/worker/mail/remote-token.ts";
import type { NewEmail } from "@open-workspace/email/worker/mailbox/schema.ts";
import { z } from "zod";

import { sessionCookie } from "./cookies.ts";
import { readJson } from "./json.ts";
import { env, hooks, mailbox, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

/**
 * Message bodies and the remote images in them: bodies come from the colo's
 * cache after the first read, and the image proxy takes the conversation's
 * token as its only credential (no session, nothing in D1).
 */

type Person = { userId: string; mailboxId: string; cookie: string };

/** A conversation as the mail API answers it: each message's body and image tokens. */
const conversationBody = z.object({
  messages: z.array(
    z.looseObject({
      bodyHtml: z.string().nullable(),
      remoteTokens: z.record(z.string(), z.string()).nullable(),
    })
  ),
});

async function createPerson(
  name: string,
  workspace: { domain: string; adminId: string }
): Promise<Person> {
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

async function seedHtmlMessage(person: Person) {
  const id = `msg_html_${person.mailboxId}`;
  const key = `mailboxes/${person.mailboxId}/messages/${id}/body.html`;
  await env.MAIL_STORAGE.put(key, `<p>Hello <img src="${imageUrl}"></p>`);

  const email: NewEmail = {
    id,
    conversationId: `conv_${id}`,
    direction: "incoming",
    fromJson: [{ address: "news@example.net", name: null }],
    toJson: [{ address: "person@example.test", name: null }],
    subject: "Newsletter",
    preview: "Hello",
    bodyText: "Hello",
    bodyHtmlR2Key: key,
    timelineAt: new Date(1_700_000_000_000),
    transportState: "received",
  };

  await mailbox(person.mailboxId).seedMailbox([], [email]);

  return `conv_${id}`;
}

async function openConversation(person: Person, conversationId: string) {
  const response = await worker.fetch(
    new Request(
      `http://example.test/api/mail/conversations/${conversationId}?mailboxId=${person.mailboxId}`,
      { headers: { cookie: person.cookie } }
    )
  );

  expect(response.status).toBe(200);

  const [message] = (await readJson(response, conversationBody)).messages;

  return {
    message: required(message, "the conversation has a message"),
    timing: response.headers.get("server-timing") ?? "",
  };
}

/** The remote image tokens of the conversation's message. */
async function remoteTokens(person: Person, conversationId: string) {
  const { message } = await openConversation(person, conversationId);

  return required(message.remoteTokens, "the message has remote images");
}

/** The person's token for the newsletter's image. */
async function imageToken(person: Person, conversationId: string) {
  return required(
    (await remoteTokens(person, conversationId))[imageUrl],
    "the message holds a token for the image"
  );
}

function proxy(
  query: Record<string, string>,
  headers: Record<string, string> = {}
) {
  return worker.fetch(
    new Request(
      `http://example.test/api/mail/remote?${new URLSearchParams(query)}`,
      { headers }
    )
  );
}

// Unique per run: the colo cache outlives the workspace reset.
const imageUrl = `https://images.example.net/logo-${crypto.randomUUID()}.png`;
const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

const imageFetches = () =>
  internet.requests.filter((request) => request.url === imageUrl).length;

let ada: Person;
let bob: Person;
let adaConversation: string;
let bobConversation: string;

beforeAll(async () => {
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

  const workspace = {
    domain: "example.test",
    adminId: required(admin, "the bootstrap creates an admin").id,
  };

  ada = await createPerson("Ada", workspace);
  bob = await createPerson("Bob", workspace);
  adaConversation = await seedHtmlMessage(ada);
  bobConversation = await seedHtmlMessage(bob);
});

describe("message bodies", () => {
  it("come from the colo's cache once one request read them from R2", async () => {
    const first = await openConversation(ada, adaConversation);
    expect(first.message.bodyHtml).toContain("Hello");
    expect(first.timing).toContain("r2;dur=");
    // The cache write runs after the response.

    const later = await poll(
      () => openConversation(ada, adaConversation),
      (read) => !read.timing.includes("r2;"),
      { timeout: 2000, interval: 100 }
    );

    expect(later.message.bodyHtml).toBe(first.message.bodyHtml);
    expect(later.timing).not.toContain("r2;");
    expect(later.timing).toContain("cache;dur=");
  });
});

describe("GET /api/mail/remote", () => {
  it("serves an image with the conversation's token, without the session or D1", async () => {
    internet.handle((request) =>
      request.target.toString() === imageUrl
        ? new Response(imageBytes, { headers: { "content-type": "image/png" } })
        : undefined
    );
    const tokens = await remoteTokens(ada, adaConversation);
    // One token per image the HTML holds.
    expect(Object.keys(tokens)).toEqual([imageUrl]);

    const token = required(tokens[imageUrl], "a token for the image");
    expect(token).toStartWith(`${ada.userId}.`);

    const query = { mailboxId: ada.mailboxId, token, url: imageUrl };

    const response = await proxy(query);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(imageBytes);
    expect(response.headers.get("server-timing")).not.toContain("d1;");
    expect(imageFetches()).toBe(1);

    // Everyone's later requests for the URL come from the colo's cache.
    const bobToken = await imageToken(bob, bobConversation);

    // The cache write runs after the first response.
    const again = await poll(
      () => proxy({ mailboxId: bob.mailboxId, token: bobToken, url: imageUrl }),
      (answer) => !answer.headers.get("server-timing")?.includes("fetch;"),
      { timeout: 2000, interval: 100 }
    );

    expect(again.status).toBe(200);
    expect(again.headers.get("server-timing")).not.toContain("fetch;");
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(imageBytes);
  });

  it("refuses a missing, forged, expired, or another mailbox's token, or one for another image", async () => {
    const [adaToken, bobToken] = await Promise.all([
      imageToken(ada, adaConversation),
      imageToken(bob, bobConversation),
    ]);

    const url = imageUrl;

    expect((await proxy({ mailboxId: ada.mailboxId, url })).status).toBe(400);
    // Wrong mailbox: Ada's token for Bob's mailbox, Bob's for Ada's.
    expect(
      (await proxy({ mailboxId: bob.mailboxId, token: adaToken, url })).status
    ).toBe(403);
    expect(
      (await proxy({ mailboxId: ada.mailboxId, token: bobToken, url })).status
    ).toBe(403);
    // Another person's id on a valid signature.
    const [, expiry, signature] = adaToken.split(".");
    expect(
      (
        await proxy({
          mailboxId: ada.mailboxId,
          token: `${bob.userId}.${expiry}.${signature}`,
          url,
        })
      ).status
    ).toBe(403);

    // Expired: issued two windows ago.
    const expired = await hooks.call<string>(
      "worker.remoteToken",
      ada.userId,
      ada.mailboxId,
      url,
      Date.now() - 2 * REMOTE_TOKEN_WINDOW_MS
    );

    const refused = await proxy({
      mailboxId: ada.mailboxId,
      token: expired,
      url,
    });

    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    // The session cookie is no substitute.
    expect(
      (await proxy({ mailboxId: ada.mailboxId, url }, { cookie: ada.cookie }))
        .status
    ).toBe(400);

    // A token fetches only the image it was issued for, never another URL.
    const otherUrls = [
      `https://images.example.net/other-${crypto.randomUUID()}.png`,
      "http://[::ffff:7f00:1]/secret.png",
    ];

    expect(
      await Promise.all(
        otherUrls.map(
          async (other) =>
            (
              await proxy({
                mailboxId: ada.mailboxId,
                token: adaToken,
                url: other,
              })
            ).status
        )
      )
    ).toEqual([403, 403]);
  });

  it("keeps refusing private and non-http targets with a valid token", async () => {
    // Tokens signed for these URLs, as if a message held them.
    const signed = (url: string) =>
      hooks.call<string>(
        "worker.remoteToken",
        ada.userId,
        ada.mailboxId,
        url,
        Date.now()
      );

    // Each is refused on its own; none depends on another.
    await Promise.all(
      [
        "http://127.0.0.1/secret.png",
        "http://[::ffff:7f00:1]/secret.png",
        "http://[fd00::1]/secret.png",
      ].map(async (url) => {
        const blocked = await proxy({
          mailboxId: ada.mailboxId,
          token: await signed(url),
          url,
        });

        expect(blocked.status, url).toBe(400);
        await blocked.body?.cancel();
      })
    );

    const notImage = `https://images.example.net/page-${crypto.randomUUID()}.html`;
    internet.handle((request) =>
      request.target.toString() === notImage
        ? new Response("<html></html>", {
            headers: { "content-type": "text/html" },
          })
        : undefined
    );
    expect(
      (
        await proxy({
          mailboxId: ada.mailboxId,
          token: await signed(notImage),
          url: notImage,
        })
      ).status
    ).toBe(502);
  });
});
