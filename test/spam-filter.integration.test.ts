import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { setGlobalAiProcessingEnabled } from "../worker/ai/configuration";
import { createDb } from "../worker/db/client";
import { domains, mailboxMembers, mailboxes, users } from "../worker/db/schema";
import { mailboxStub } from "../worker/mailbox";

type Mailbox = ReturnType<typeof mailboxStub>;

function rawMessage(input: {
  from: string;
  authentication?: string;
  subject?: string;
}) {
  return [
    ...(input.authentication
      ? [`Authentication-Results: mx.cloudflare.net; ${input.authentication}`]
      : []),
    `From: ${input.from}`,
    "To: me@example.test",
    `Subject: ${input.subject ?? "Hello"}`,
    `Message-ID: <${crypto.randomUUID()}@example.net>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Plain text body.",
  ].join("\r\n");
}

async function deliver(mailbox: Mailbox, mailboxId: string, raw: string) {
  const id = `spam-${crypto.randomUUID()}`;
  const rawObjectKey = `test/spam/${id}.eml`;
  await env.MAIL_STORAGE.put(rawObjectKey, raw);
  await mailbox.enqueueInbound({
    id,
    mailboxId,
    rawObjectKey,
    envelopeFrom: "bounce@example.net",
    envelopeTo: "me@example.test",
    receivedAt: Date.now(),
  });
  await runInDurableObject(mailbox, async (instance, state) => {
    await state.storage.deleteAlarm();
    await instance.alarm();
  });
  const email = await mailbox.getEmail(`msg_${id}`);
  expect(email).toBeTruthy();
  const { mailbox_state: mailboxState } = await runInDurableObject(
    mailbox,
    (_instance, state) => state.storage.sql.exec<{ mailbox_state: string }>(
      "select mailbox_state from conversations where id = ?",
      email!.conversationId,
    ).one(),
  );
  return { email: email!, mailboxState };
}

function modelResponse(spam: boolean) {
  return {
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [{
      type: "message",
      content: [{
        type: "output_text",
        text: JSON.stringify({
          spam,
          spamConfidence: 0.99,
          folderId: null,
          folderConfidence: 0,
          reason: "Test verdict",
        }),
      }],
    }],
  };
}

describe("local spam filter delivery", () => {
  it("scores inbound mail, applies lists, and keeps allowed senders out of AI spam", async () => {
    const mailboxId = `mbx_x_${crypto.randomUUID()}`;
    const mailbox = mailboxStub(env, mailboxId);

    const spoofed = await deliver(mailbox, mailboxId, rawMessage({
      from: "Bank <billing@bank.example>",
      authentication: "dkim=fail header.d=bank.example; spf=fail smtp.mailfrom=bank.example; dmarc=fail header.from=bank.example",
    }));
    expect(spoofed.mailboxState).toBe("spam");
    expect(spoofed.email).toMatchObject({
      spamScore: 75,
      spamVerdict: "spam",
      aiClassificationJson: null,
    });
    expect(spoofed.email.spamReasonsJson?.[0]?.reason).toContain("DMARC failed");

    const suspicious = await deliver(mailbox, mailboxId, rawMessage({
      from: "news@shop.example",
      authentication: "dkim=pass header.d=shop.example; spf=pass smtp.mailfrom=shop.example; dmarc=fail header.from=shop.example",
    }));
    expect(suspicious.mailboxState).toBe("active");
    expect(suspicious.email).toMatchObject({ spamScore: 45, spamVerdict: "suspicious" });

    const unauthenticated = "dkim=fail header.d=partner.example; spf=fail smtp.mailfrom=partner.example";
    const stranger = await deliver(mailbox, mailboxId, rawMessage({
      from: "someone@partner.example",
      authentication: unauthenticated,
    }));
    expect(stranger.email).toMatchObject({ spamScore: 40, spamVerdict: "suspicious" });
    await mailbox.insertEmail({
      id: "msg_outgoing_partner",
      conversationId: "conv_outgoing_partner",
      direction: "outgoing",
      fromJson: [{ address: "me@example.test", name: null }],
      toJson: [{ address: "Known@partner.example", name: null }],
      subject: "Earlier",
      timelineAt: new Date(),
      transportState: "submitted",
    });
    const known = await deliver(mailbox, mailboxId, rawMessage({
      from: "known@partner.example",
      authentication: unauthenticated,
    }));
    expect(known.email).toMatchObject({ spamScore: 0, spamVerdict: "clean" });
    expect(known.email.spamReasonsJson).toContainEqual({
      points: -40,
      reason: "You have written to this sender before",
    });

    await mailbox.setSpamSender("evil.example", "block");
    await mailbox.setSpamSender("friend@evil.example", "allow");
    const blocked = await deliver(mailbox, mailboxId, rawMessage({
      from: "promo@mail.evil.example",
      authentication: "dkim=pass header.d=evil.example; spf=pass smtp.mailfrom=evil.example; dmarc=pass header.from=evil.example",
    }));
    expect(blocked.mailboxState).toBe("spam");
    expect(blocked.email.spamVerdict).toBe("spam");

    const allowed = await deliver(mailbox, mailboxId, rawMessage({
      from: "friend@evil.example",
      authentication: "dkim=fail; spf=fail; dmarc=fail",
    }));
    expect(allowed.mailboxState).toBe("active");
    expect(allowed.email.spamVerdict).toBe("clean");

    // AI may add a spam decision, but never for an allow-listed sender.
    const bindings = await runInDurableObject(
      mailbox,
      (instance) => Reflect.get(instance, "bindings") as Env,
    );
    await setGlobalAiProcessingEnabled(env.DB, true);
    Reflect.set(bindings, "AI", { run: async () => modelResponse(true) });
    try {
      const aiAllowed = await deliver(mailbox, mailboxId, rawMessage({
        from: "friend@evil.example",
      }));
      expect(aiAllowed.email.aiClassificationJson).toMatchObject({ spam: true });
      expect(aiAllowed.mailboxState).toBe("active");

      const aiSpam = await deliver(mailbox, mailboxId, rawMessage({
        from: "unknown@elsewhere.example",
      }));
      expect(aiSpam.email.spamVerdict).toBe("clean");
      expect(aiSpam.mailboxState).toBe("spam");

      Reflect.set(bindings, "AI", { run: async () => modelResponse(false) });
      const aiBlocked = await deliver(mailbox, mailboxId, rawMessage({
        from: "promo@evil.example",
      }));
      expect(aiBlocked.mailboxState).toBe("spam");
    } finally {
      Reflect.deleteProperty(bindings, "AI");
      await setGlobalAiProcessingEnabled(env.DB, false);
    }
  });
});

describe("spam settings API", () => {
  it("validates input and requires send access to change settings", async () => {
    const bootstrap = await exports.default.fetch(
      new Request("http://example.test/api/auth/mock/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
      }),
    );
    expect(bootstrap.status).toBe(200);
    const adminCookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    await bootstrap.json();
    const mailboxList = await exports.default.fetch(
      new Request("http://example.test/api/mail/mailboxes", {
        headers: { cookie: adminCookie },
      }),
    );
    const mailboxId = (await mailboxList.json<{
      mailboxes: Array<{ id: string }>;
    }>()).mailboxes[0]!.id;

    const call = (cookie: string, path: string, method = "GET", json?: unknown) =>
      exports.default.fetch(new Request(
        `http://example.test/api/mail/mailboxes/${mailboxId}/spam${path}`,
        {
          method,
          headers: { cookie, "content-type": "application/json" },
          body: json === undefined ? undefined : JSON.stringify(json),
        },
      ));

    const defaults = await call(adminCookie, "");
    expect(await defaults.json()).toEqual({
      ok: true,
      settings: { spamThreshold: 70, suspiciousThreshold: 40, allow: [], block: [] },
    });

    for (const invalid of [
      { spamThreshold: 50, suspiciousThreshold: 50, allow: [], block: [] },
      { spamThreshold: 70, suspiciousThreshold: 40, allow: ["not a domain"], block: [] },
      { spamThreshold: 70, suspiciousThreshold: 40, allow: ["a.example"], block: ["A.example"] },
      { spamThreshold: 101, suspiciousThreshold: 40, allow: [], block: [] },
    ]) {
      const response = await call(adminCookie, "", "PUT", invalid);
      expect(response.status).toBe(400);
      await response.body?.cancel();
    }

    const saved = await call(adminCookie, "", "PUT", {
      spamThreshold: 80,
      suspiciousThreshold: 30,
      allow: ["Friend@Partner.Example", "friend@partner.example"],
      block: ["@spam.example"],
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      ok: true,
      settings: {
        spamThreshold: 80,
        suspiciousThreshold: 30,
        allow: ["friend@partner.example"],
        block: ["spam.example"],
      },
    });

    const moved = await call(
      adminCookie,
      `/senders/${encodeURIComponent("Friend@partner.example")}`,
      "PUT",
      { list: "block" },
    );
    expect(await moved.json()).toMatchObject({
      settings: { allow: [], block: ["friend@partner.example", "spam.example"] },
    });
    const invalidEntry = await call(adminCookie, "/senders/nope", "PUT", { list: "block" });
    expect(invalidEntry.status).toBe(400);
    await invalidEntry.json();
    const missing = await call(adminCookie, "/senders/missing.example", "DELETE");
    expect(missing.status).toBe(404);
    await missing.json();
    const removed = await call(adminCookie, "/senders/spam.example", "DELETE");
    expect(await removed.json()).toMatchObject({
      settings: { block: ["friend@partner.example"] },
    });

    const db = createDb(env.DB);
    const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
    const [domain] = await db.select({ id: domains.id }).from(domains).where(eq(domains.isPrimary, true)).limit(1);
    const readerId = `usr_spam_reader_${crypto.randomUUID()}`;
    const sharedId = `mbx_spam_shared_${crypto.randomUUID()}`;
    const now = new Date();
    await db.batch([
      db.insert(users).values({
        id: readerId,
        name: "Reader",
        role: "member",
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(mailboxes).values({
        id: sharedId,
        localPart: "spamshared",
        domainId: domain!.id,
        displayName: "Shared",
        ownerUserId: null,
        createdByUserId: admin!.id,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(mailboxMembers).values({
        mailboxId: sharedId,
        userId: readerId,
        canSend: false,
        createdAt: now,
      }),
    ] as const);
    const login = await exports.default.fetch(
      new Request("http://example.test/api/auth/mock/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: readerId }),
      }),
    );
    const readerCookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
    await login.json();

    const notMember = await call(readerCookie, "");
    expect(notMember.status).toBe(403);
    await notMember.json();

    const readerCall = (path: string, method = "GET", json?: unknown) =>
      exports.default.fetch(new Request(
        `http://example.test/api/mail/mailboxes/${sharedId}/spam${path}`,
        {
          method,
          headers: { cookie: readerCookie, "content-type": "application/json" },
          body: json === undefined ? undefined : JSON.stringify(json),
        },
      ));
    const read = await readerCall("");
    expect(read.status).toBe(200);
    await read.json();
    for (const response of [
      await readerCall("", "PUT", { spamThreshold: 70, suspiciousThreshold: 40, allow: [], block: [] }),
      await readerCall("/senders/spam.example", "PUT", { list: "block" }),
      await readerCall("/senders/spam.example", "DELETE"),
    ]) {
      expect(response.status).toBe(403);
      await response.json();
    }

    const anonymous = await exports.default.fetch(
      `http://example.test/api/mail/mailboxes/${sharedId}/spam`,
    );
    expect(anonymous.status).toBe(401);
    await anonymous.json();
  });
});
