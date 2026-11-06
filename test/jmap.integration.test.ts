import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createAccountApiToken } from "../worker/auth/api-tokens";
import { createDb } from "../worker/db/client";
import { accountApiTokens, domains, mailboxMembers, mailboxes, users } from "../worker/db/schema";
import { decodeIdPart, decodeState, encodeIdPart, encodeState, parseScopedId, scopedId } from "../worker/jmap/ids";
import { mailboxStub } from "../worker/mailbox";

const CORE = "urn:ietf:params:jmap:core";
const MAIL = "urn:ietf:params:jmap:mail";
const SUBMISSION = "urn:ietf:params:jmap:submission";
const USING = [CORE, MAIL, SUBMISSION];

type Call = [string, Record<string, unknown>, string];
type JmapResponse = { methodResponses: Call[]; sessionState: string; createdIds?: Record<string, string> };

async function fixture() {
  const db = createDb(env.DB);
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const userId = `usr_${suffix}`;
  const domainName = `d${suffix}.test`;
  const personal = `mbx_p${suffix}`;
  const shared = `mbx_s${suffix}`;
  const now = new Date();
  await db.insert(users).values({ id: userId, name: "Jay", role: "member", status: "active", createdAt: now, updatedAt: now });
  await db.batch([
    db.insert(domains).values({ id: `dom_${suffix}`, name: domainName, createdByUserId: userId, createdAt: now, updatedAt: now }),
    db.insert(mailboxes).values({
      id: personal, localPart: "jay", domainId: `dom_${suffix}`, displayName: "Jay", ownerUserId: userId,
      isPrimary: true, createdByUserId: userId, createdAt: now, updatedAt: now,
    }),
    db.insert(mailboxes).values({
      id: shared, localPart: "support", domainId: `dom_${suffix}`, displayName: "Support", ownerUserId: null,
      createdByUserId: userId, createdAt: now, updatedAt: now,
    }),
    db.insert(mailboxMembers).values({ mailboxId: personal, userId, canSend: true, createdAt: now }),
    db.insert(mailboxMembers).values({ mailboxId: shared, userId, canSend: false, createdAt: now }),
  ] as const);
  const token = await createAccountApiToken(db, userId, "jmap");
  const address = `jay@${domainName}`;
  const t = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  await env.MAIL_STORAGE.put(`jmap-test/${suffix}/body.html`, "<p>Hello <b>html</b></p>");
  await env.MAIL_STORAGE.put(`jmap-test/${suffix}/raw.eml`, "Subject: Raw\r\n\r\nraw body");
  await env.MAIL_STORAGE.put(`jmap-test/${suffix}/report.pdf`, "%PDF-fake");
  await mailboxStub(env, personal).seedMailbox([{ id: "fld_projects", name: "Projects", sortOrder: 100 }], [
    {
      id: "msg_a1", conversationId: "conv_a", direction: "incoming", messageIdHeader: "<a1@example.net>",
      fromJson: [{ address: "alice@example.net", name: "Alice" }], toJson: [{ address, name: null }],
      subject: "Quarterly planning", preview: "Agenda for the planning meeting", bodyText: "Agenda for the planning meeting",
      bodyHtmlR2Key: `jmap-test/${suffix}/body.html`, rawMimeR2Key: `jmap-test/${suffix}/raw.eml`,
      attachmentsJson: [{
        id: "att_report", r2Key: `jmap-test/${suffix}/report.pdf`, filename: "report.pdf", contentType: "application/pdf",
        size: 9, contentId: null, disposition: "attachment", delivery: "attached", downloadTokenHash: null, downloadExpiresAt: null,
      }],
      timelineAt: t(30), transportState: "received",
    },
    {
      id: "msg_a2", conversationId: "conv_a", direction: "incoming", messageIdHeader: "<a2@example.net>",
      inReplyToJson: ["<a1@example.net>"], referencesJson: ["<a1@example.net>"],
      fromJson: [{ address: "bob@example.net", name: "Bob" }], toJson: [{ address, name: null }],
      subject: "Re: Quarterly planning", preview: "Sounds good", bodyText: "Sounds good",
      timelineAt: t(20), transportState: "received",
    },
    {
      id: "msg_b1", conversationId: "conv_b", direction: "outgoing",
      fromJson: [{ address, name: "Jay" }], toJson: [{ address: "carol@example.net", name: null }],
      subject: "Invoice", preview: "Attached invoice", bodyText: "Attached invoice",
      timelineAt: t(10), transportState: "submitted",
    },
  ]);
  await mailboxStub(env, shared).seedMailbox([], [{
    id: "msg_s1", conversationId: "conv_s", direction: "incoming",
    fromJson: [{ address: "customer@example.net", name: null }], toJson: [{ address: `support@${domainName}`, name: null }],
    subject: "Help needed", preview: "Cannot log in", bodyText: "Cannot log in",
    timelineAt: t(5), transportState: "received",
  }]);
  const accountId = encodeIdPart(userId);
  return {
    userId, token, address, personal, shared, accountId,
    mbox: (mailboxId: string, view: string) => scopedId(mailboxId, view),
    email: (id: string, mailboxId = personal) => scopedId(mailboxId, id),
  };
}

function authHeaders(token: string, scheme: "Bearer" | "Basic" = "Bearer") {
  return {
    authorization: scheme === "Bearer" ? `Bearer ${token}` : `Basic ${btoa(`anything:${token}`)}`,
    "content-type": "application/json",
  };
}

async function rawApi(token: string, body: string) {
  return exports.default.fetch(new Request("http://example.test/jmap/api", {
    method: "POST",
    headers: authHeaders(token),
    body,
  }));
}

async function jmap(token: string, methodCalls: Call[], using = USING) {
  const response = await rawApi(token, JSON.stringify({ using, methodCalls }));
  expect(response.status).toBe(200);
  return (await response.json<JmapResponse>()).methodResponses;
}

async function call(token: string, name: string, args: Record<string, unknown>) {
  const [response] = await jmap(token, [[name, args, "c"]]);
  return response!;
}

async function deliverInbound(mailboxId: string, to: string, subject: string) {
  const id = `inbound-${crypto.randomUUID()}`;
  const key = `jmap-test/${id}.eml`;
  await env.MAIL_STORAGE.put(key, [
    "From: Dave <dave@example.net>",
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${id}@example.net>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "A new message.",
  ].join("\r\n"));
  const stub = mailboxStub(env, mailboxId);
  await stub.enqueueInbound({ id, mailboxId, rawObjectKey: key, envelopeFrom: "dave@example.net", envelopeTo: to, receivedAt: Date.now() });
  await runDurableObjectAlarm(stub);
  return `msg_${id}`;
}

describe("JMAP ids and state", () => {
  it("round-trips scoped ids and account state strings", () => {
    expect(encodeIdPart("msg_abc")).toBe("msg_abc");
    expect(decodeIdPart(encodeIdPart("Pitch Decks"))).toBe("Pitch Decks");
    const id = scopedId("mbx_1", "conv-with-dash", "att_x");
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(parseScopedId(id)).toEqual({ mailboxId: "mbx_1", objectId: "conv-with-dash", part: "att_x" });
    expect(parseScopedId(scopedId("mbx_1", "msg_1", "_text"))?.part).toBe("_text");
    expect(parseScopedId("not an id")).toBeNull();
    const state = new Map([["mbx_b", { seq: 7, canSend: false }], ["mbx_a", { seq: 3, canSend: true }]]);
    expect(encodeState(state)).toBe("mbx_a.3.w,mbx_b.7.r");
    expect(decodeState(encodeState(state))).toEqual(state);
    expect(decodeState("garbage")).toBeNull();
  });
});

describe("JMAP session and authentication", () => {
  it("serves the session to Bearer and Basic tokens and rejects revoked ones", async () => {
    const f = await fixture();
    const session = await exports.default.fetch(new Request("http://example.test/.well-known/jmap", {
      headers: authHeaders(f.token.token),
    }));
    expect(session.status).toBe(200);
    const body = await session.json<Record<string, any>>();
    expect(Object.keys(body.capabilities)).toEqual(USING);
    expect(body.capabilities[CORE]).toMatchObject({ maxCallsInRequest: 32, maxObjectsInGet: 500, maxObjectsInSet: 500 });
    expect(body.primaryAccounts[MAIL]).toBe(f.accountId);
    expect(body.accounts[f.accountId]).toMatchObject({ name: f.address, isPersonal: true });
    expect(body.apiUrl).toBe("http://example.test/jmap/api");

    const basic = await exports.default.fetch(new Request("http://example.test/.well-known/jmap", {
      headers: authHeaders(f.token.token, "Basic"),
    }));
    expect(basic.status).toBe(200);
    await basic.arrayBuffer();

    const anonymous = await exports.default.fetch(new Request("http://example.test/jmap/api", { method: "POST", body: "{}" }));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("Basic");
    await anonymous.arrayBuffer();

    await createDb(env.DB).delete(accountApiTokens).where(eq(accountApiTokens.id, f.token.id));
    for (const scheme of ["Bearer", "Basic"] as const) {
      const revoked = await exports.default.fetch(new Request("http://example.test/jmap/api", {
        method: "POST",
        headers: authHeaders(f.token.token, scheme),
        body: JSON.stringify({ using: USING, methodCalls: [] }),
      }));
      expect(revoked.status).toBe(401);
      await revoked.arrayBuffer();
    }
  });
});

describe("JMAP request envelope", () => {
  it("reports request-level problems", async () => {
    const f = await fixture();
    const notJson = await rawApi(f.token.token, "{");
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ type: "urn:ietf:params:jmap:error:notJSON" });
    const notRequest = await rawApi(f.token.token, JSON.stringify({ using: "x" }));
    expect(await notRequest.json()).toMatchObject({ type: "urn:ietf:params:jmap:error:notRequest" });
    const unknownCapability = await rawApi(f.token.token, JSON.stringify({ using: ["urn:example:nope"], methodCalls: [] }));
    expect(await unknownCapability.json()).toMatchObject({ type: "urn:ietf:params:jmap:error:unknownCapability" });
    const tooMany = await rawApi(f.token.token, JSON.stringify({
      using: USING,
      methodCalls: Array.from({ length: 33 }, (_, index) => ["Core/echo", {}, String(index)]),
    }));
    expect(await tooMany.json()).toMatchObject({ type: "urn:ietf:params:jmap:error:limit", limit: "maxCallsInRequest" });
  });

  it("echoes, resolves result references, and reports method errors", async () => {
    const f = await fixture();
    const responses = await jmap(f.token.token, [
      ["Core/echo", { hello: "world" }, "0"],
      ["Email/query", { accountId: f.accountId, filter: { inMailbox: f.mbox(f.personal, "inbox") } }, "1"],
      ["Email/get", {
        accountId: f.accountId,
        "#ids": { resultOf: "1", name: "Email/query", path: "/ids" },
        properties: ["subject", "threadId"],
      }, "2"],
      ["Thread/get", {
        accountId: f.accountId,
        "#ids": { resultOf: "2", name: "Email/get", path: "/list/*/threadId" },
      }, "3"],
      ["Email/get", { accountId: f.accountId, "#ids": { resultOf: "9", name: "Email/query", path: "/ids" } }, "4"],
      ["Nope/get", {}, "5"],
      ["Email/get", { accountId: "someone-else", ids: [] }, "6"],
      ["Email/get", { accountId: f.accountId, ids: Array.from({ length: 501 }, (_, index) => `x${index}`) }, "7"],
      ["Email/get", { accountId: f.accountId, ids: [], properties: ["header:List-Id"] }, "8"],
    ]);
    expect(responses[0]).toEqual(["Core/echo", { hello: "world" }, "0"]);
    expect(responses[1]![1].ids).toEqual([f.email("msg_a2"), f.email("msg_a1")]);
    expect(responses[2]![1].list).toEqual([
      { id: f.email("msg_a2"), subject: "Re: Quarterly planning", threadId: f.email("conv_a") },
      { id: f.email("msg_a1"), subject: "Quarterly planning", threadId: f.email("conv_a") },
    ]);
    expect(responses[3]![1].list).toEqual([
      { id: f.email("conv_a"), emailIds: [f.email("msg_a1"), f.email("msg_a2")] },
    ]);
    expect(responses.slice(4).map(([name, args, id]) => [name, args.type, id])).toEqual([
      ["error", "invalidResultReference", "4"],
      ["error", "unknownMethod", "5"],
      ["error", "accountNotFound", "6"],
      ["error", "requestTooLarge", "7"],
      ["error", "invalidArguments", "8"],
    ]);

    const withoutMail = await jmap(f.token.token, [["Mailbox/get", { accountId: f.accountId }, "0"]], [CORE]);
    expect(withoutMail[0]![1].type).toBe("unknownMethod");
  });
});

describe("JMAP mailboxes", () => {
  it("maps each OpenWorkspace mailbox to a tree with rights and counts", async () => {
    const f = await fixture();
    const [, result] = await call(f.token.token, "Mailbox/get", { accountId: f.accountId, ids: null });
    const list = result.list as Array<Record<string, any>>;
    const byId = new Map(list.map((mailbox) => [mailbox.id, mailbox]));
    const top = byId.get(encodeIdPart(f.personal))!;
    expect(top).toMatchObject({ name: f.address, parentId: null, role: null });
    expect(top.myRights.maySubmit).toBe(true);
    expect(byId.get(f.mbox(f.personal, "inbox"))).toMatchObject({
      role: "inbox", parentId: top.id, totalEmails: 2, unreadEmails: 2, totalThreads: 1, unreadThreads: 1,
    });
    expect(byId.get(f.mbox(f.personal, "sent"))).toMatchObject({ role: "sent", totalEmails: 1, unreadEmails: 0 });
    expect(byId.get(f.mbox(f.personal, "spam"))?.role).toBe("junk");
    expect(byId.get(f.mbox(f.personal, "fld_projects"))).toMatchObject({ name: "Projects", role: null, totalEmails: 0 });
    expect(byId.get(f.mbox(f.personal, "fld_projects"))!.myRights).toMatchObject({ mayRename: true, mayDelete: true });
    expect(byId.get(encodeIdPart(f.shared))!.myRights.maySubmit).toBe(false);
    expect(byId.get(f.mbox(f.shared, "inbox"))!.myRights.maySubmit).toBe(false);
    expect(list).toHaveLength(2 + 2 * 5 + 1);

    const [, query] = await call(f.token.token, "Mailbox/query", {
      accountId: f.accountId, filter: { role: "inbox" }, sort: [{ property: "name" }],
    });
    expect(query.ids).toEqual([f.mbox(f.personal, "inbox"), f.mbox(f.shared, "inbox")]);
  });

  it("creates, renames, and destroys custom folders and reports the changes", async () => {
    const f = await fixture();
    const [, before] = await call(f.token.token, "Mailbox/get", { accountId: f.accountId, ids: [] });
    const responses = await jmap(f.token.token, [
      ["Mailbox/set", {
        accountId: f.accountId,
        create: {
          n1: { name: "Receipts", parentId: encodeIdPart(f.personal) },
          bad: { name: "Nested", parentId: f.mbox(f.personal, "inbox") },
        },
        update: { [f.mbox(f.personal, "inbox")]: { name: "Renamed" } },
        destroy: [f.mbox(f.personal, "trash")],
      }, "0"],
    ]);
    const set = responses[0]![1] as Record<string, any>;
    const created = set.created.n1.id as string;
    expect(set.notCreated.bad).toMatchObject({ type: "invalidProperties", properties: ["parentId"] });
    expect(set.notUpdated[f.mbox(f.personal, "inbox")].type).toBe("forbidden");
    expect(set.notDestroyed[f.mbox(f.personal, "trash")].type).toBe("forbidden");

    const [, changes] = await call(f.token.token, "Mailbox/changes", { accountId: f.accountId, sinceState: before.state });
    expect(changes.created).toEqual([created]);

    // Read-only members can manage folders, consistent with the web app.
    const shared = await call(f.token.token, "Mailbox/set", {
      accountId: f.accountId,
      create: { s: { name: "Escalations", parentId: encodeIdPart(f.shared) } },
    });
    expect(Object.keys(shared[1].created as object)).toEqual(["s"]);

    const renamed = await call(f.token.token, "Mailbox/set", {
      accountId: f.accountId, update: { [created]: { name: "Bills" } },
    });
    expect(renamed[1].updated).toEqual({ [created]: null });
    const [, afterRename] = await call(f.token.token, "Mailbox/changes", {
      accountId: f.accountId, sinceState: changes.newState,
    });
    expect(afterRename.updated).toContain(created);
    expect(afterRename.updatedProperties).toBeNull();

    // A folder with mail needs onDestroyRemoveEmails.
    await call(f.token.token, "Email/set", {
      accountId: f.accountId, update: { [f.email("msg_a1")]: { mailboxIds: { [created]: true } } },
    });
    const refused = await call(f.token.token, "Mailbox/set", { accountId: f.accountId, destroy: [created] });
    expect((refused[1].notDestroyed as any)[created].type).toBe("mailboxHasEmail");
    const removed = await call(f.token.token, "Mailbox/set", {
      accountId: f.accountId, destroy: [created], onDestroyRemoveEmails: true,
    });
    expect(removed[1].destroyed).toEqual([created]);
    const [, afterDestroy] = await call(f.token.token, "Mailbox/changes", {
      accountId: f.accountId, sinceState: afterRename.newState,
    });
    expect(afterDestroy.destroyed).toEqual([created]);
    const [, email] = await call(f.token.token, "Email/get", {
      accountId: f.accountId, ids: [f.email("msg_a1")], properties: ["mailboxIds"],
    });
    expect((email.list as any)[0].mailboxIds).toEqual({ [f.mbox(f.personal, "inbox")]: true });

    // Granting send access is a myRights change on that mailbox's tree.
    await createDb(env.DB).update(mailboxMembers).set({ canSend: true }).where(eq(mailboxMembers.mailboxId, f.shared));
    const [, afterRights] = await call(f.token.token, "Mailbox/changes", {
      accountId: f.accountId, sinceState: afterDestroy.newState,
    });
    expect(afterRights.updated).toContain(f.mbox(f.shared, "inbox"));
    expect(afterRights.updatedProperties).toBeNull();
  });

  it("prunes the change log and raises the floor", async () => {
    const stub = mailboxStub(env, `mbx_prune_${crypto.randomUUID().replaceAll("-", "")}`);
    await runInDurableObject(stub, (_instance, durable) => {
      durable.storage.sql.exec("insert into jmap_changes (seq, type, object_id, kind) values (5, 'Email', 'old', 'created')");
      durable.storage.sql.exec("insert into jmap_changes (seq, type, object_id, kind) values (51000, 'Email', 'new', 'created')");
    });
    expect(await stub.jmapSequence()).toEqual({ seq: 51000, floor: 1000 });
    expect(await stub.jmapChanges("Email", 999, 10)).toBeNull();
    expect(await stub.jmapChanges("Email", 1000, 10)).toMatchObject({ created: ["new"], seq: 51000 });
  });
});

describe("JMAP emails", () => {
  it("returns header fields, bodies, attachments, and downloadable blobs", async () => {
    const f = await fixture();
    const [, result] = await call(f.token.token, "Email/get", {
      accountId: f.accountId,
      ids: [f.email("msg_a1"), f.email("msg_b1"), f.email("msg_missing")],
      fetchAllBodyValues: true,
    });
    const [incoming, outgoing] = result.list as Array<Record<string, any>>;
    expect(result.notFound).toEqual([f.email("msg_missing")]);
    expect(incoming).toMatchObject({
      id: f.email("msg_a1"),
      threadId: f.email("conv_a"),
      mailboxIds: { [f.mbox(f.personal, "inbox")]: true },
      keywords: {},
      messageId: ["a1@example.net"],
      from: [{ name: "Alice", email: "alice@example.net" }],
      to: [{ name: null, email: f.address }],
      cc: null,
      subject: "Quarterly planning",
      hasAttachment: true,
      textBody: [{ partId: "1", type: "text/plain" }],
      htmlBody: [{ partId: "2", type: "text/html" }],
      attachments: [{ name: "report.pdf", type: "application/pdf", size: 9, disposition: "attachment" }],
      bodyValues: {
        1: { value: "Agenda for the planning meeting", isTruncated: false },
        2: { value: "<p>Hello <b>html</b></p>", isTruncated: false },
      },
    });
    expect(incoming.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
    expect(outgoing).toMatchObject({ keywords: { $seen: true }, mailboxIds: { [f.mbox(f.personal, "sent")]: true } });

    const [, truncated] = await call(f.token.token, "Email/get", {
      accountId: f.accountId, ids: [f.email("msg_a1")], properties: ["bodyValues"], fetchTextBodyValues: true, maxBodyValueBytes: 6,
    });
    expect((truncated.list as any)[0].bodyValues).toEqual({ 1: { value: "Agenda", isTruncated: true, isEncodingProblem: false } });

    const download = async (blobId: string, name: string) => exports.default.fetch(new Request(
      `http://example.test/jmap/download/${f.accountId}/${blobId}/${name}?type=application/pdf`,
      { headers: authHeaders(f.token.token) },
    ));
    const attachment = await download(incoming.attachments[0].blobId, "report.pdf");
    expect(attachment.status).toBe(200);
    expect(attachment.headers.get("content-type")).toBe("application/pdf");
    expect(attachment.headers.get("content-disposition")).toContain("attachment");
    expect(attachment.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await attachment.text()).toBe("%PDF-fake");
    const raw = await exports.default.fetch(new Request(
      `http://example.test/jmap/download/${f.accountId}/${incoming.blobId}/m.eml`,
      { headers: authHeaders(f.token.token) },
    ));
    expect(raw.headers.get("content-type")).toBe("message/rfc822");
    expect(await raw.text()).toContain("raw body");
    const foreign = await download(scopedId("mbx_other", "msg_a1"), "x");
    expect(foreign.status).toBe(404);
    await foreign.arrayBuffer();
  });

  it("queries with filters, sorting, collapsing, paging, and snippets", async () => {
    const f = await fixture();
    const query = async (args: Record<string, unknown>) =>
      (await call(f.token.token, "Email/query", { accountId: f.accountId, ...args }))[1];
    expect((await query({})).ids).toEqual([
      f.email("msg_s1", f.shared), f.email("msg_b1"), f.email("msg_a2"), f.email("msg_a1"),
    ]);
    expect((await query({ sort: [{ property: "receivedAt", isAscending: true }], limit: 1 })).ids).toEqual([f.email("msg_a1")]);
    expect((await query({ collapseThreads: true, filter: { inMailbox: f.mbox(f.personal, "inbox") } })).ids)
      .toEqual([f.email("msg_a2")]);
    expect((await query({ filter: { text: "agenda" } })).ids).toEqual([f.email("msg_a1")]);
    expect((await query({ filter: { from: "bob@" } })).ids).toEqual([f.email("msg_a2")]);
    expect((await query({ filter: { to: "carol" } })).ids).toEqual([f.email("msg_b1")]);
    expect((await query({ filter: { subject: "invoice" } })).ids).toEqual([f.email("msg_b1")]);
    expect((await query({ filter: { inMailbox: f.mbox(f.personal, "sent") } })).ids).toEqual([f.email("msg_b1")]);
    expect((await query({ filter: { body: "agenda" } })).ids).toEqual([f.email("msg_a1")]);
    expect((await query({ filter: { hasAttachment: true } })).ids).toEqual([f.email("msg_a1")]);
    expect((await query({ filter: { inMailboxOtherThan: [f.mbox(f.personal, "inbox"), f.mbox(f.shared, "inbox")] } })).ids)
      .toEqual([f.email("msg_b1")]);
    expect((await query({ filter: { operator: "NOT", conditions: [{ hasKeyword: "$seen" }] } })).ids).toEqual([
      f.email("msg_s1", f.shared), f.email("msg_a2"), f.email("msg_a1"),
    ]);
    const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
    expect((await query({ filter: { before: cutoff } })).ids).toEqual([f.email("msg_a2"), f.email("msg_a1")]);
    expect((await query({ filter: { after: cutoff } })).ids).toEqual([f.email("msg_s1", f.shared), f.email("msg_b1")]);
    const paged = await query({ position: 1, limit: 2, calculateTotal: true });
    expect(paged).toMatchObject({ position: 1, total: 4, ids: [f.email("msg_b1"), f.email("msg_a2")] });
    expect((await query({ anchor: f.email("msg_a2"), anchorOffset: -1, limit: 1 })).ids).toEqual([f.email("msg_b1")]);
    expect((await query({ position: -1 })).ids).toEqual([f.email("msg_a1")]);

    const errors = await jmap(f.token.token, [
      ["Email/query", { accountId: f.accountId, sort: [{ property: "subject" }] }, "0"],
      ["Email/query", { accountId: f.accountId, filter: { minSize: 10 } }, "1"],
      ["Email/query", { accountId: f.accountId, anchor: "nope" }, "2"],
      ["Email/query", { accountId: f.accountId, filter: { before: "yesterday" } }, "3"],
    ]);
    expect(errors.map(([, args]) => args.type)).toEqual([
      "unsupportedSort", "unsupportedFilter", "anchorNotFound", "invalidArguments",
    ]);

    const [, snippets] = await call(f.token.token, "SearchSnippet/get", {
      accountId: f.accountId, filter: { text: "planning" }, emailIds: [f.email("msg_a1"), f.email("msg_zz")],
    });
    expect(snippets).toMatchObject({
      list: [{ emailId: f.email("msg_a1"), subject: "Quarterly <mark>planning</mark>" }],
      notFound: [f.email("msg_zz")],
    });
  });

  it("tracks changes from every kind of mutation", async () => {
    const f = await fixture();
    const [, initial] = await call(f.token.token, "Email/get", { accountId: f.accountId, ids: [] });
    const changes = async (type: string, sinceState: unknown, extra: Record<string, unknown> = {}) =>
      (await call(f.token.token, `${type}/changes`, { accountId: f.accountId, sinceState, ...extra }))[1] as Record<string, any>;
    expect(await changes("Email", initial.state)).toMatchObject({ created: [], updated: [], destroyed: [], newState: initial.state });

    // Inbound delivery through the alarm pipeline.
    const inboundId = await deliverInbound(f.personal, f.address, "Brand new");
    const afterInbound = await changes("Email", initial.state);
    expect(afterInbound).toMatchObject({ created: [f.email(inboundId)], updated: [], destroyed: [] });
    const threadsAfterInbound = await changes("Thread", initial.state);
    expect(threadsAfterInbound.created).toHaveLength(1);
    const countsOnly = await changes("Mailbox", initial.state);
    expect(countsOnly.updatedProperties).toEqual(["totalEmails", "unreadEmails", "totalThreads", "unreadThreads"]);
    expect(countsOnly.updated).toContain(f.mbox(f.personal, "inbox"));

    // Read state.
    const seen = await call(f.token.token, "Email/set", {
      accountId: f.accountId, ifInState: afterInbound.newState, update: { [f.email("msg_a1")]: { "keywords/$seen": true } },
    });
    expect(seen[1].updated).toEqual({ [f.email("msg_a1")]: null });
    const afterSeen = await changes("Email", afterInbound.newState);
    expect(afterSeen).toMatchObject({ created: [], updated: [f.email("msg_a1")] });
    const stale = await call(f.token.token, "Email/set", {
      accountId: f.accountId, ifInState: afterInbound.newState, update: {},
    });
    expect(stale[1].type).toBe("stateMismatch");
    const [, keywordQuery] = await call(f.token.token, "Email/query", {
      accountId: f.accountId, filter: { inMailbox: f.mbox(f.personal, "inbox"), notKeyword: "$seen" },
    });
    expect(keywordQuery.ids).not.toContain(f.email("msg_a1"));

    // Moving one message moves its conversation; both messages change.
    const archive = f.mbox(f.personal, "archive");
    const moved = await call(f.token.token, "Email/set", {
      accountId: f.accountId,
      update: {
        [f.email("msg_a2")]: { mailboxIds: { [archive]: true } },
        [f.email("msg_b1")]: { [`mailboxIds/${f.mbox(f.personal, "inbox")}`]: true },
        [f.email("msg_a1")]: { mailboxIds: { [archive]: true, [f.mbox(f.personal, "trash")]: true } },
      },
    });
    expect(moved[1].updated).toEqual({ [f.email("msg_a2")]: null });
    expect((moved[1].notUpdated as any)[f.email("msg_b1")].type).toBe("invalidProperties");
    expect((moved[1].notUpdated as any)[f.email("msg_a1")].type).toBe("invalidProperties");
    const afterMove = await changes("Email", afterSeen.newState);
    expect(afterMove.updated.toSorted()).toEqual([f.email("msg_a1"), f.email("msg_a2")].toSorted());
    const [, movedEmail] = await call(f.token.token, "Email/get", {
      accountId: f.accountId, ids: [f.email("msg_a1")], properties: ["mailboxIds"],
    });
    expect((movedEmail.list as any)[0].mailboxIds).toEqual({ [archive]: true });

    // Destroy moves to Trash, then destroys permanently from Trash.
    await call(f.token.token, "Email/set", { accountId: f.accountId, destroy: [f.email("msg_a1")] });
    const afterTrash = await changes("Email", afterMove.newState);
    expect(afterTrash.updated.toSorted()).toEqual([f.email("msg_a1"), f.email("msg_a2")].toSorted());
    const destroyed = await call(f.token.token, "Email/set", { accountId: f.accountId, destroy: [f.email("msg_a1")] });
    expect(destroyed[1].destroyed).toEqual([f.email("msg_a1")]);
    const afterDelete = await changes("Email", afterTrash.newState);
    expect(afterDelete.destroyed.toSorted()).toEqual([f.email("msg_a1"), f.email("msg_a2")].toSorted());
    expect((await changes("Thread", afterTrash.newState)).destroyed).toEqual([f.email("conv_a")]);
    // Created and destroyed within the window cancel out for older states.
    expect((await changes("Email", initial.state)).destroyed.toSorted())
      .toEqual([f.email("msg_a1"), f.email("msg_a2")].toSorted());

    // Paging with maxChanges resumes from the intermediate state.
    const firstPage = await changes("Email", initial.state, { maxChanges: 1 });
    expect(firstPage.hasMoreChanges).toBe(true);
    expect([...firstPage.created, ...firstPage.updated, ...firstPage.destroyed]).toHaveLength(1);
    let state = firstPage.newState;
    const seenIds = new Set([...firstPage.created, ...firstPage.updated, ...firstPage.destroyed]);
    for (let page = 0; page < 10; page += 1) {
      const next = await changes("Email", state, { maxChanges: 1 });
      for (const id of [...next.created, ...next.updated, ...next.destroyed]) seenIds.add(id);
      state = next.newState;
      if (!next.hasMoreChanges) break;
    }
    expect(seenIds).toEqual(new Set([f.email(inboundId), f.email("msg_a1"), f.email("msg_a2")]));

    // Unknown states and states older than the retained window.
    expect((await call(f.token.token, "Email/changes", { accountId: f.accountId, sinceState: "x" }))[1].type)
      .toBe("cannotCalculateChanges");
    await runInDurableObject(mailboxStub(env, f.personal), (_instance, durable) => {
      durable.storage.sql.exec("update jmap_change_floor set floor = 1000000 where id = 1");
    });
    expect((await call(f.token.token, "Email/changes", { accountId: f.accountId, sinceState: initial.state }))[1].type)
      .toBe("cannotCalculateChanges");
  });

  it("enforces the read-only permission matrix", async () => {
    const f = await fixture();
    const sharedEmail = f.email("msg_s1", f.shared);
    // Moving and marking read is allowed for read-only members, as in the app.
    const trash = await call(f.token.token, "Email/set", {
      accountId: f.accountId, update: { [sharedEmail]: { "keywords/$seen": true, mailboxIds: { [f.mbox(f.shared, "trash")]: true } } },
    });
    expect(trash[1].updated).toEqual({ [sharedEmail]: null });
    const refused = await call(f.token.token, "Email/set", { accountId: f.accountId, destroy: [sharedEmail] });
    expect((refused[1].notDestroyed as any)[sharedEmail].type).toBe("forbidden");
    // Cross-mailbox moves are not representable.
    const cross = await call(f.token.token, "Email/set", {
      accountId: f.accountId, update: { [sharedEmail]: { mailboxIds: { [f.mbox(f.personal, "inbox")]: true } } },
    });
    expect((cross[1].notUpdated as any)[sharedEmail].type).toBe("invalidProperties");

    const [, identities] = await call(f.token.token, "Identity/get", { accountId: f.accountId });
    expect(identities.list).toEqual([expect.objectContaining({ id: encodeIdPart(f.personal), email: f.address })]);
    const responses = await jmap(f.token.token, [
      ["Email/set", {
        accountId: f.accountId,
        create: { d: { from: [{ email: `support@${f.address.split("@")[1]}` }], to: [{ email: "x@example.net" }], subject: "Hi", textBody: [{ partId: "t" }], bodyValues: { t: { value: "Hi" } } } },
      }, "0"],
      ["EmailSubmission/set", {
        accountId: f.accountId, create: { s: { identityId: encodeIdPart(f.shared), emailId: "#d" } },
      }, "1"],
    ]);
    expect((responses[1]![1].notCreated as any).s.type).toBe("forbiddenToSend");
  });

  it("sends a draft through EmailSubmission and reports it in queryChanges", async () => {
    const f = await fixture();
    const inbox = f.mbox(f.personal, "inbox");
    const [, before] = await call(f.token.token, "Email/query", { accountId: f.accountId, filter: { inMailbox: f.mbox(f.personal, "sent") } });
    const responses = await jmap(f.token.token, [
      ["Email/set", {
        accountId: f.accountId,
        create: {
          draft: {
            mailboxIds: { [inbox]: true },
            keywords: { $draft: true, $seen: true },
            from: [{ name: "Jay", email: f.address }],
            to: [{ email: "alice@example.net" }],
            subject: "Re: Quarterly planning",
            inReplyTo: ["a2@example.net"],
            textBody: [{ partId: "t", type: "text/plain" }],
            htmlBody: [{ partId: "h", type: "text/html" }],
            bodyValues: { t: { value: "See you there" }, h: { value: "<p>See you there</p>" } },
          },
          unsent: { from: [{ email: f.address }], to: [{ email: "x@example.net" }] },
        },
      }, "0"],
      ["EmailSubmission/set", {
        accountId: f.accountId,
        create: { send: { identityId: encodeIdPart(f.personal), emailId: "#draft" } },
        onSuccessDestroyEmail: ["#send"],
      }, "1"],
    ]);
    const [emailSet, submission, implicit] = responses;
    const draftId = (emailSet![1].created as any).draft.id;
    expect((emailSet![1].notCreated as any).unsent.type).toBe("forbidden");
    const sent = (submission![1].created as any).send;
    expect(sent).toMatchObject({ undoStatus: "final", threadId: f.email("conv_a") });
    expect(implicit).toEqual(["Email/set", expect.objectContaining({ destroyed: [draftId] }), "1"]);

    const [, email] = await call(f.token.token, "Email/get", {
      accountId: f.accountId, ids: [sent.emailId], properties: ["subject", "to", "inReplyTo", "mailboxIds"], fetchAllBodyValues: true,
    });
    expect((email.list as any)[0]).toMatchObject({
      subject: "Re: Quarterly planning",
      to: [{ email: "alice@example.net" }],
      inReplyTo: ["a2@example.net"],
      mailboxIds: { [inbox]: true, [f.mbox(f.personal, "sent")]: true },
    });
    const stored = await mailboxStub(env, f.personal).getEmail(parseScopedId(sent.emailId)!.objectId);
    expect(stored).toMatchObject({ transportState: "submitted", bodyText: "See you there" });

    const [, queryChanges] = await call(f.token.token, "Email/queryChanges", {
      accountId: f.accountId, filter: { inMailbox: f.mbox(f.personal, "sent") }, sinceQueryState: before.queryState,
    });
    expect(queryChanges.added).toEqual([{ id: sent.emailId, index: 0 }]);
    expect(queryChanges.removed).toContain(sent.emailId);
  });
});
