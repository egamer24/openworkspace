import { describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import {
  internet,
  MCP_TEST_ORIGIN,
  mcpAccessToken,
} from "@open-workspace/core/testing";
import { z } from "zod";

import { jsonValue, readJson } from "./json.ts";
import type { JsonValue } from "./json.ts";
import { pollUntil } from "./poll.ts";
import { env, hooks, mailbox, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

const origin = MCP_TEST_ORIGIN;

/** A JMAP method call or response: name, arguments, call id. */
type MethodCall = [name: string, args: Record<string, JsonValue>, id: string];

const invocation = z.tuple([z.string(), z.looseObject({}), z.string()]);

type Invocation = z.output<typeof invocation>;

const jmapResponse = z.object({ methodResponses: z.array(invocation) });

/** A /get answer: the objects found. */
const getResult = z.looseObject({ list: z.array(z.looseObject({})) });

/** An object that could not be created, updated or destroyed, and why. */
const setError = z.looseObject({ type: z.string() });

/** A /set answer, with the parts the tests read. */
const setResult = z.looseObject({
  oldState: z.string().nullish(),
  newState: z.string().nullish(),
  created: z.record(z.string(), z.looseObject({ id: z.string() })).nullish(),
  updated: z.record(z.string(), z.looseObject({}).nullable()).nullish(),
  destroyed: z.array(z.string()).nullish(),
  notCreated: z.record(z.string(), setError).nullish(),
  notUpdated: z.record(z.string(), setError).nullish(),
});

/** An EmailSubmission/set answer: each submission names the email it sent. */
const submissionSetResult = z.looseObject({
  created: z.record(z.string(), z.looseObject({ emailId: z.string() })),
});

/** What the push service is sent: a verification (with its code) or a state change. */
const pushBody = z.looseObject({ verificationCode: z.string().optional() });

/** The arguments of a method response, which the test expects to be there, parsed with `schema`. */
function result<S extends z.ZodType>(
  response: Invocation | undefined,
  schema: S
): z.output<S> {
  return schema.parse(required(response, "a method response")[1]);
}

/** The arguments of a method response the test expects to be there. */
function args(response: Invocation | undefined) {
  return required(response, "a method response")[1];
}

/** The `name=value` pair of the session cookie a mock sign-in sets. */
function sessionCookie(response: Response) {
  const [cookie] = required(
    response.headers.get("set-cookie"),
    "the sign-in sets a session cookie"
  ).split(";", 1);

  return required(cookie, "Set-Cookie starts with name=value");
}

async function jmap(token: string, methodCalls: MethodCall[]) {
  const response = await worker.fetch(
    new Request(`${origin}/jmap/api`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        using: [
          "urn:ietf:params:jmap:core",
          "urn:ietf:params:jmap:mail",
          "urn:ietf:params:jmap:submission",
        ],
        methodCalls,
      }),
    })
  );

  const body = jsonValue.parse(await response.json());

  expect(response.status, JSON.stringify(body)).toBe(200);

  return jmapResponse.parse(body).methodResponses;
}

describe("JMAP", () => {
  it("serves mail to OAuth clients with mail scopes", async () => {
    const bootstrap = await worker.fetch(
      new Request(`${origin}/api/auth/mock/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Jay Map", email: "jay@example.test" }),
      })
    );

    const cookie = sessionCookie(bootstrap);
    expect(bootstrap.status).toBe(200);

    // Without a token, the client learns where to sign in.
    const anonymous = await worker.fetch(new Request(`${origin}/jmap/session`));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource/jmap"
    );

    const metadata = await worker.fetch(
      new Request(`${origin}/.well-known/oauth-protected-resource/jmap`)
    );

    expect(await metadata.json()).toMatchObject({
      resource: `${origin}/jmap`,
      scopes_supported: [
        "mail.read",
        "mail.send",
        "mail.organize",
        "offline_access",
      ],
    });

    const { accessToken, scope } = await mcpAccessToken(cookie, {
      scope: "mail.read mail.send mail.organize",
      resource: `${origin}/jmap`,
    });

    expect(scope).toBe("mail.read mail.send mail.organize");

    const wellKnown = await worker.fetch(
      new Request(`${origin}/.well-known/jmap`, { redirect: "manual" })
    );

    expect(wellKnown.headers.get("location")).toBe("/jmap/session");

    const sessionResponse = await worker.fetch(
      new Request(`${origin}/jmap/session`, {
        headers: { authorization: `Bearer ${accessToken}` },
      })
    );

    const session = await readJson(
      sessionResponse,
      z.object({
        primaryAccounts: z.record(z.string(), z.string()),
        accounts: z.record(
          z.string(),
          z.looseObject({ name: z.string(), isPersonal: z.boolean() })
        ),
        apiUrl: z.string(),
      })
    );

    const accountId = required(
      session.primaryAccounts["urn:ietf:params:jmap:mail"],
      "the session has a primary mail account"
    );

    expect(session.accounts[accountId]).toMatchObject({
      name: "jay@example.test",
      isPersonal: true,
    });
    expect(session.apiUrl).toBe(`${origin}/jmap/api`);

    const rawKey = `mailboxes/${accountId}/raw/jmap.eml`;
    await env.MAIL_STORAGE.put(
      rawKey,
      "Subject: Quarterly plan\r\n\r\nThe plan is attached."
    );
    await mailbox(accountId).seedMailbox(
      [],
      [
        {
          id: "msg_jmap_1",
          conversationId: "conv_jmap",
          direction: "incoming",
          fromJson: [{ address: "ada@example.net", name: "Ada" }],
          toJson: [{ address: "jay@example.test", name: null }],
          subject: "Quarterly plan",
          preview: "The plan is attached.",
          bodyText: "The plan is attached.",
          timelineAt: new Date("2026-10-30T10:00:00Z"),
          transportState: "received",
          rawMimeR2Key: rawKey,
        },
        {
          id: "msg_jmap_2",
          conversationId: "conv_other",
          direction: "incoming",
          fromJson: [{ address: "bob@example.net", name: null }],
          toJson: [{ address: "jay@example.test", name: null }],
          subject: "Lunch",
          bodyText: "Tomorrow?",
          timelineAt: new Date("2026-10-31T10:00:00Z"),
          transportState: "received",
        },
      ]
    );

    const [mailboxes, query, emails] = await jmap(accessToken, [
      ["Mailbox/get", { accountId, ids: null }, "m"],
      [
        "Email/query",
        {
          accountId,
          filter: { inMailbox: "inbox", text: "plan" },
          sort: [{ property: "receivedAt" }],
        },
        "q",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: [
            "subject",
            "from",
            "mailboxIds",
            "keywords",
            "threadId",
            "bodyValues",
            "textBody",
          ],
          fetchTextBodyValues: true,
        },
        "g",
      ],
    ]);

    const inbox = result(mailboxes, getResult).list.find(
      (entry) => entry.role === "inbox"
    );

    expect(inbox).toMatchObject({
      id: "inbox",
      totalEmails: 2,
      unreadEmails: 2,
    });
    expect(args(query)).toMatchObject({ ids: ["msg_jmap_1"], total: 1 });
    expect(result(emails, getResult).list[0]).toMatchObject({
      id: "msg_jmap_1",
      subject: "Quarterly plan",
      from: [{ name: "Ada", email: "ada@example.net" }],
      mailboxIds: { inbox: true },
      keywords: {},
      threadId: "conv_jmap",
      bodyValues: { text: { value: "The plan is attached." } },
    });

    const [set, after, thread] = await jmap(accessToken, [
      [
        "Email/set",
        {
          accountId,
          update: {
            msg_jmap_1: { "keywords/$seen": true, "mailboxIds/archive": true },
          },
        },
        "s",
      ],
      [
        "Email/get",
        {
          accountId,
          ids: ["msg_jmap_1"],
          properties: ["mailboxIds", "keywords"],
        },
        "a",
      ],
      ["Thread/get", { accountId, ids: ["conv_jmap"] }, "t"],
    ]);

    const updated = result(set, setResult);
    expect(updated).toMatchObject({ updated: { msg_jmap_1: null } });
    expect(updated.oldState).not.toBe(updated.newState);
    expect(result(after, getResult).list[0]).toMatchObject({
      mailboxIds: { archive: true },
      keywords: { $seen: true },
    });
    expect(result(thread, getResult).list).toEqual([
      { id: "conv_jmap", emailIds: ["msg_jmap_1"] },
    ]);

    const [unsupported] = await jmap(accessToken, [
      [
        "Email/set",
        { accountId, update: { msg_jmap_2: { "keywords/$flagged": true } } },
        "f",
      ],
    ]);

    expect(result(unsupported, setResult).notUpdated?.msg_jmap_2).toMatchObject(
      {
        type: "invalidProperties",
      }
    );

    const download = await worker.fetch(
      new Request(
        `${origin}/jmap/download/${accountId}/raw~msg_jmap_1/plan.eml?type=message/rfc822`,
        { headers: { authorization: `Bearer ${accessToken}` } }
      )
    );

    expect(await download.text()).toContain("Quarterly plan");

    const [identities, created, submitted, implicit] = await jmap(accessToken, [
      ["Identity/get", { accountId }, "i"],
      [
        "Email/set",
        {
          accountId,
          create: {
            draft: {
              mailboxIds: { drafts: true },
              to: [{ email: "ada@example.net" }],
              subject: "Re: Quarterly plan",
              bodyValues: { body: { value: "Looks good." } },
              textBody: [{ partId: "body", type: "text/plain" }],
            },
          },
        },
        "c",
      ],
      [
        "EmailSubmission/set",
        {
          accountId,
          create: { send: { identityId: accountId, emailId: "#draft" } },
          onSuccessDestroyEmail: ["#send"],
        },
        "x",
      ],
    ]);

    expect(result(identities, getResult).list).toEqual([
      expect.objectContaining({ email: "jay@example.test" }),
    ]);

    const draftId = required(
      result(created, setResult).created?.draft,
      "the draft was created"
    ).id;

    // A draft created in the drafts mailbox is kept until it is sent.
    expect(draftId).toMatch(/^drf_/u);
    expect(required(submitted, "a submission response")[0]).toBe(
      "EmailSubmission/set"
    );

    const sentId = required(
      result(submitted, submissionSetResult).created.send,
      "the submission was created"
    ).emailId;

    expect(implicit).toEqual([
      "Email/set",
      expect.objectContaining({ destroyed: [draftId] }),
      "x",
    ]);

    const [sent, gone] = await jmap(accessToken, [
      [
        "Email/get",
        {
          accountId,
          ids: [sentId],
          properties: ["subject", "mailboxIds", "to"],
        },
        "y",
      ],
      ["Email/get", { accountId, ids: [draftId] }, "g"],
    ]);

    // Sending it deleted the draft.
    expect(args(gone)).toMatchObject({ list: [], notFound: [draftId] });

    expect(result(sent, getResult).list[0]).toMatchObject({
      subject: "Re: Quarterly plan",
      mailboxIds: { sent: true },
      to: [{ email: "ada@example.net" }],
    });

    // Methods outside mail answer with a method-level error, not a failed request.
    const unknownMethod = await jmap(accessToken, [
      ["Calendar/get", { accountId }, "z"],
    ]);

    expect(unknownMethod[0]).toEqual([
      "error",
      expect.objectContaining({ type: "unknownMethod" }),
      "z",
    ]);
  });

  /** Signs in as the workspace's first person (bootstrapped by the first test). */
  async function signIn(scope = "mail.read mail.send mail.organize") {
    const admin = z
      .object({ id: z.string() })
      .parse(
        await env.DB.prepare(
          "SELECT id FROM users WHERE role = 'admin'"
        ).first()
      );

    const login = await worker.fetch(
      new Request(`${origin}/api/auth/mock/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: admin.id }),
      })
    );

    const cookie = sessionCookie(login);

    const { accessToken } = await mcpAccessToken(cookie, {
      scope,
      resource: `${origin}/jmap`,
    });

    const session = await readJson(
      await worker.fetch(
        new Request(`${origin}/jmap/session`, {
          headers: { authorization: `Bearer ${accessToken}` },
        })
      ),
      z.object({
        primaryAccounts: z.record(z.string(), z.string()),
        capabilities: z.record(z.string(), jsonValue),
      })
    );

    return {
      accessToken,
      accountId: required(
        session.primaryAccounts["urn:ietf:params:jmap:mail"],
        "the session has a primary mail account"
      ),
      session,
    };
  }

  it("sends uploaded blobs as attachments", async () => {
    const { accessToken, accountId, session } = await signIn();
    expect(session.capabilities["urn:ietf:params:jmap:core"]).toMatchObject({
      maxSizeUpload: 500_000_000,
    });

    const uploaded = await worker.fetch(
      new Request(`${origin}/jmap/upload/${accountId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "text/plain",
        },
        body: "Agenda: budget, hiring.",
      })
    );

    expect(uploaded.status).toBe(201);

    const blob = await readJson(
      uploaded,
      z.object({
        blobId: z.string(),
        size: z.number(),
        type: z.string(),
        accountId: z.string(),
      })
    );

    expect(blob).toMatchObject({ accountId, size: 23, type: "text/plain" });

    const download = await worker.fetch(
      new Request(
        `${origin}/jmap/download/${accountId}/${blob.blobId}/agenda.txt`,
        { headers: { authorization: `Bearer ${accessToken}` } }
      )
    );

    expect(await download.text()).toBe("Agenda: budget, hiring.");

    const [, submitted] = await jmap(accessToken, [
      [
        "Email/set",
        {
          accountId,
          create: {
            draft: {
              to: [{ email: "ada@example.net" }],
              subject: "Agenda",
              bodyValues: { body: { value: "Attached." } },
              textBody: [{ partId: "body", type: "text/plain" }],
              attachments: [
                { blobId: blob.blobId, type: "text/plain", name: "agenda.txt" },
              ],
            },
          },
        },
        "c",
      ],
      [
        "EmailSubmission/set",
        { accountId, create: { send: { emailId: "#draft" } } },
        "x",
      ],
    ]);

    const sentId = required(
      result(submitted, submissionSetResult).created.send,
      "the submission was created"
    ).emailId;

    const [sent] = await jmap(accessToken, [
      [
        "Email/get",
        {
          accountId,
          ids: [sentId],
          properties: ["attachments", "hasAttachment"],
        },
        "g",
      ],
    ]);

    expect(result(sent, getResult).list[0]).toMatchObject({
      hasAttachment: true,
      attachments: [
        expect.objectContaining({
          name: "agenda.txt",
          type: "text/plain",
          size: 23,
        }),
      ],
    });

    const [rejected] = await jmap(accessToken, [
      [
        "Email/set",
        {
          accountId,
          create: {
            other: {
              to: [{ email: "ada@example.net" }],
              bodyValues: { body: { value: "x" } },
              textBody: [{ partId: "body", type: "text/plain" }],
              attachments: [
                {
                  blobId: `upl~upl_${"0".repeat(32)}`,
                  type: "text/plain",
                  name: "missing.txt",
                },
              ],
            },
          },
        },
        "r",
      ],
    ]);

    expect(result(rejected, setResult).notCreated?.other).toMatchObject({
      type: "blobNotFound",
    });
  });

  /** Uploads a raw message and answers its blob id. */
  async function uploadMessage(token: string, accountId: string, raw: string) {
    const uploaded = await worker.fetch(
      new Request(`${origin}/jmap/upload/${accountId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "message/rfc822",
        },
        body: raw,
      })
    );

    expect(uploaded.status).toBe(201);

    return (await readJson(uploaded, z.object({ blobId: z.string() }))).blobId;
  }

  it("shares one set of drafts with the web app", async () => {
    const { accessToken, accountId } = await signIn();

    const [created] = await jmap(accessToken, [
      [
        "Email/set",
        {
          accountId,
          create: {
            note: {
              mailboxIds: { drafts: true },
              keywords: { $draft: true, $seen: true },
              to: [{ email: "grace@example.net" }],
              subject: "Plans",
              bodyValues: { body: { value: "Thinking about it" } },
              textBody: [{ partId: "body", type: "text/plain" }],
            },
          },
        },
        "c",
      ],
    ]);

    const draftId = required(
      result(created, setResult).created?.note,
      "the draft was created"
    ).id;

    // The web app lists it among the person's drafts.
    const user = z
      .object({ id: z.string() })
      .parse(
        await env.DB.prepare(
          "SELECT id FROM users WHERE role = 'admin'"
        ).first()
      );

    expect(await mailbox(accountId).listDrafts(user.id)).toEqual([
      expect.objectContaining({ id: draftId, subject: "Plans" }),
    ]);

    const [mailboxes, query, got, moved, kept] = await jmap(accessToken, [
      ["Mailbox/query", { accountId, filter: { role: "drafts" } }, "m"],
      ["Email/query", { accountId, filter: { inMailbox: "drafts" } }, "q"],
      [
        "Email/get",
        {
          accountId,
          ids: [draftId],
          properties: ["mailboxIds", "keywords", "to", "subject", "bodyValues"],
          fetchTextBodyValues: true,
        },
        "g",
      ],
      [
        "Email/set",
        { accountId, update: { [draftId]: { "mailboxIds/archive": true } } },
        "u",
      ],
      [
        "Email/set",
        { accountId, update: { [draftId]: { "keywords/$seen": true } } },
        "k",
      ],
    ]);

    expect(args(mailboxes)).toMatchObject({ ids: ["drafts"] });
    expect(args(query)).toMatchObject({ ids: [draftId], total: 1 });
    expect(result(got, getResult).list).toEqual([
      expect.objectContaining({
        mailboxIds: { drafts: true },
        keywords: { $draft: true, $seen: true },
        to: [{ name: null, email: "grace@example.net" }],
        subject: "Plans",
        bodyValues: {
          text: expect.objectContaining({ value: "Thinking about it" }),
        },
      }),
    ]);
    // A draft stays in Drafts until it is sent.
    expect(result(moved, setResult).notUpdated?.[draftId]).toMatchObject({
      type: "invalidProperties",
    });
    expect(result(kept, setResult).updated).toEqual({ [draftId]: null });

    const [destroyed, after] = await jmap(accessToken, [
      ["Email/set", { accountId, destroy: [draftId] }, "d"],
      ["Email/query", { accountId, filter: { inMailbox: "drafts" } }, "q"],
    ]);

    expect(result(destroyed, setResult).destroyed).toEqual([draftId]);
    expect(args(after)).toMatchObject({ ids: [], total: 0 });
  });

  it("imports uploaded messages into a mailbox", async () => {
    const { accessToken, accountId } = await signIn();
    await mailbox(accountId).createFolder("fld_receipts", "Receipts");

    const receipt = await uploadMessage(
      accessToken,
      accountId,
      [
        "From: Shop <orders@shop.example>",
        "To: jay@example.test",
        "Subject: Your receipt",
        "Message-ID: <receipt-1@shop.example>",
        "Date: Mon, 02 Mar 2026 09:00:00 +0000",
        "",
        "Thanks for your order.",
      ].join("\r\n")
    );

    const shipped = await uploadMessage(
      accessToken,
      accountId,
      [
        "From: Shop <orders@shop.example>",
        "To: jay@example.test",
        "Subject: Re: Your receipt",
        "Message-ID: <receipt-2@shop.example>",
        "In-Reply-To: <receipt-1@shop.example>",
        "References: <receipt-1@shop.example>",
        "Date: Tue, 03 Mar 2026 09:00:00 +0000",
        "",
        "Your order has shipped.",
      ].join("\r\n")
    );

    const [imported] = await jmap(accessToken, [
      [
        "Email/import",
        {
          accountId,
          emails: {
            receipt: {
              blobId: receipt,
              mailboxIds: { fld_receipts: true },
              keywords: { $seen: true },
              receivedAt: "2026-03-02T10:30:00Z",
            },
            shipped: { blobId: shipped, mailboxIds: { fld_receipts: true } },
            flagged: {
              blobId: shipped,
              mailboxIds: { inbox: true },
              keywords: { $flagged: true },
            },
            missing: {
              blobId: `upl~upl_${"0".repeat(32)}`,
              mailboxIds: { inbox: true },
            },
          },
        },
        "i",
      ],
    ]);

    const importResult = result(imported, setResult);
    expect(importResult.newState).not.toBe(importResult.oldState);
    expect(importResult.notCreated).toEqual({
      flagged: expect.objectContaining({
        type: "invalidProperties",
        properties: ["keywords"],
      }),
      missing: expect.objectContaining({ type: "blobNotFound" }),
    });

    const receiptId = required(
      importResult.created?.receipt,
      "the receipt was imported"
    ).id;

    const shippedId = required(
      importResult.created?.shipped,
      "the shipping note was imported"
    ).id;

    const [got] = await jmap(accessToken, [
      [
        "Email/get",
        {
          accountId,
          ids: [receiptId, shippedId],
          properties: [
            "subject",
            "mailboxIds",
            "keywords",
            "receivedAt",
            "threadId",
          ],
        },
        "g",
      ],
    ]);

    const [first, second] = result(got, getResult).list;
    expect(first).toMatchObject({
      subject: "Your receipt",
      mailboxIds: { fld_receipts: true },
      keywords: { $seen: true },
      receivedAt: "2026-03-02T10:30:00.000Z",
    });
    expect(second).toMatchObject({
      subject: "Re: Your receipt",
      mailboxIds: { fld_receipts: true },
      keywords: {},
      threadId: required(first, "the receipt was found").threadId,
    });

    // The same message again is the email already there.
    const [again] = await jmap(accessToken, [
      [
        "Email/import",
        {
          accountId,
          emails: { again: { blobId: receipt, mailboxIds: { inbox: true } } },
        },
        "a",
      ],
    ]);

    expect(result(again, setResult)).toMatchObject({
      created: null,
      notCreated: { again: { type: "alreadyExists", existingId: receiptId } },
    });
  });

  it("imports with mail.organize and refuses tokens without it", async () => {
    const organizer = await signIn("mail.read mail.organize");

    const note = await uploadMessage(
      organizer.accessToken,
      organizer.accountId,
      "From: Ada <ada@example.net>\r\nSubject: Old note\r\n\r\nFrom last year."
    );

    const [imported] = await jmap(organizer.accessToken, [
      [
        "Email/import",
        {
          accountId: organizer.accountId,
          emails: { note: { blobId: note, mailboxIds: { archive: true } } },
        },
        "i",
      ],
    ]);

    const noteId = required(
      result(imported, setResult).created?.note,
      "the note was imported"
    ).id;

    const [got] = await jmap(organizer.accessToken, [
      [
        "Email/get",
        {
          accountId: organizer.accountId,
          ids: [noteId],
          properties: ["mailboxIds"],
        },
        "g",
      ],
    ]);

    expect(result(got, getResult).list[0]).toMatchObject({
      mailboxIds: { archive: true },
    });

    const sender = await signIn("mail.read mail.send");

    const [refused] = await jmap(sender.accessToken, [
      [
        "Email/import",
        {
          accountId: sender.accountId,
          emails: { note: { blobId: note, mailboxIds: { inbox: true } } },
        },
        "r",
      ],
    ]);

    expect(refused).toEqual([
      "error",
      expect.objectContaining({ type: "forbidden" }),
      "r",
    ]);
  });

  it("verifies push subscriptions and pushes state changes to them", async () => {
    const { accessToken, accountId, session } = await signIn();
    expect(session.capabilities["urn:ietf:params:jmap:webpush-vapid"]).toEqual({
      applicationServerKey: required(
        (await hooks.env("VAPID_PUBLIC_KEY")).VAPID_PUBLIC_KEY,
        "the stack binds a VAPID public key"
      ),
    });
    // The push service, as the Worker reaches it.
    const posts: { url: string; body: z.output<typeof pushBody> }[] = [];
    internet.handle(async (request) => {
      if (request.target.hostname !== "push.example.net") return undefined;
      posts.push({
        url: request.url,
        body: pushBody.parse(await request.json()),
      });

      return new Response(null, { status: 201 });
    });

    const [created] = await jmap(accessToken, [
      [
        "PushSubscription/set",
        {
          create: {
            phone: {
              deviceClientId: "phone-1",
              url: "https://push.example.net/jmap/phone-1",
              types: ["Email"],
            },
          },
        },
        "p",
      ],
    ]);

    const subscriptionId = required(
      result(created, setResult).created?.phone,
      "the push subscription was created"
    ).id;

    await pollUntil(() => Promise.resolve(posts.length > 0), {
      timeoutMs: 5000,
      intervalMs: 20,
      failure: "The push service got no verification",
    });

    expect(posts).toHaveLength(1);
    const { verificationCode } = required(posts[0], "a verification post").body;
    expect(posts[0]).toMatchObject({
      url: "https://push.example.net/jmap/phone-1",
      body: { "@type": "PushVerification", pushSubscriptionId: subscriptionId },
    });

    // Unverified subscriptions get nothing.
    await hooks.call("realtime.deliverJmapStateChange", {
      mailboxId: accountId,
      state: "1",
    });
    expect(posts).toHaveLength(1);

    const [wrong, right, listed] = await jmap(accessToken, [
      [
        "PushSubscription/set",
        { update: { [subscriptionId]: { verificationCode: "nope" } } },
        "w",
      ],
      [
        "PushSubscription/set",
        {
          update: {
            [subscriptionId]: {
              verificationCode: required(
                verificationCode,
                "the verification has a code"
              ),
            },
          },
        },
        "v",
      ],
      ["PushSubscription/get", { ids: null }, "g"],
    ]);

    expect(result(wrong, setResult).notUpdated?.[subscriptionId]).toMatchObject(
      { type: "invalidProperties" }
    );
    expect(result(right, setResult).updated).toEqual({
      [subscriptionId]: null,
    });
    expect(result(listed, getResult).list).toEqual([
      {
        id: subscriptionId,
        deviceClientId: "phone-1",
        verificationCode,
        expires: expect.any(String),
        types: ["Email"],
      },
    ]);

    await hooks.call("realtime.deliverJmapStateChange", {
      mailboxId: accountId,
      state: "9",
    });
    expect(posts.at(-1)).toMatchObject({
      url: "https://push.example.net/jmap/phone-1",
      body: {
        "@type": "StateChange",
        changed: { [accountId]: { Email: "9", Mailbox: "9", Thread: "9" } },
      },
    });

    const [destroyed] = await jmap(accessToken, [
      ["PushSubscription/set", { destroy: [subscriptionId] }, "d"],
    ]);

    expect(result(destroyed, setResult).destroyed).toEqual([subscriptionId]);
  });

  it("streams state changes over EventSource", async () => {
    const { accessToken, accountId } = await signIn();
    await mailbox(accountId).seedMailbox(
      [],
      [
        {
          id: "msg_stream_1",
          conversationId: "conv_stream",
          direction: "incoming",
          fromJson: [{ address: "ada@example.net", name: null }],
          toJson: [{ address: "jay@example.test", name: null }],
          subject: "Stream",
          bodyText: "Hi",
          timelineAt: new Date(),
          transportState: "received",
        },
      ]
    );

    const stream = await worker.fetch(
      new Request(
        `${origin}/jmap/eventsource?types=*&closeafter=state&ping=0`,
        { headers: { authorization: `Bearer ${accessToken}` } }
      )
    );

    expect(stream.headers.get("content-type")).toContain("text/event-stream");

    const [stateChange] = await jmap(accessToken, [
      [
        "Email/set",
        { accountId, update: { msg_stream_1: { "keywords/$seen": true } } },
        "s",
      ],
    ]);

    const { newState } = result(stateChange, setResult);

    // closeafter=state ends the stream after the first change, so its text is complete.
    const text = await stream.text();

    const data = jsonValue.parse(
      JSON.parse(
        required(
          /event: state\ndata: (.+)\n/u.exec(text)?.[1],
          "the stream sent a state event"
        )
      )
    );

    expect(data).toEqual({
      "@type": "StateChange",
      changed: { [accountId]: expect.objectContaining({ Email: newState }) },
    });
  });
});
