import { Buffer } from "node:buffer";
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { inboundMessageId } from "../worker/mail/inbound";
import { mailboxStub } from "../worker/mailbox";
import type { NewEmail } from "../worker/mailbox/schema";

function incoming(input: {
  id: string;
  conversationId: string;
  timelineAt: Date;
  bodyText: string;
}): NewEmail {
  return {
    id: input.id,
    conversationId: input.conversationId,
    direction: "incoming",
    fromJson: [{ address: `${input.id}@example.net`, name: null }],
    toJson: [{ address: "me@example.test", name: null }],
    subject: `Subject ${input.id}`,
    preview: input.bodyText,
    bodyText: input.bodyText,
    timelineAt: input.timelineAt,
    transportState: "received",
  };
}

describe("mailbox conversation index", () => {
  it("paginates conversation messages newest-first without losing full-thread counts", async () => {
    const mailbox = mailboxStub(env, `mbx_message_pages_${crypto.randomUUID()}`);
    const conversationId = "conv_message_pages";
    const messages = Array.from({ length: 30 }, (_, index) => incoming({
      id: `msg_page_${String(index).padStart(2, "0")}`,
      conversationId,
      timelineAt: new Date(1_700_000_000_000 + index),
      bodyText: `Message ${index}`,
    }));
    await mailbox.seedMailbox([], messages);
    await mailbox.setMessageRead("usr_message_pages", messages[0]!.id, true);

    const first = await mailbox.getConversationPageSnapshot(
      conversationId,
      "usr_message_pages",
      10,
      null,
    );
    expect(first).toMatchObject({
      messageCount: 30,
      unreadCount: 29,
      hasIncoming: true,
    });
    expect(first?.messages.map((message) => message.id)).toEqual(
      messages.slice(20).map((message) => message.id),
    );
    expect(first?.next).toBeTruthy();

    const second = await mailbox.getConversationPageSnapshot(
      conversationId,
      "usr_message_pages",
      10,
      first!.next,
    );
    expect(second?.messages.map((message) => message.id)).toEqual(
      messages.slice(10, 20).map((message) => message.id),
    );
    expect(second?.messageCount).toBe(30);
    expect(second?.unreadCount).toBe(29);
  });

  it("applies successful AI folder and spam decisions before notifications", async () => {
    const mailboxId = `mbx_ai_success_${crypto.randomUUID()}`;
    const mailbox = mailboxStub(env, mailboxId);
    const folder = await mailbox.createFolder("fld_product", "Product");
    expect(folder.status).toBe("ok");
    if (folder.status !== "ok") throw new Error("Product folder was not created");

    await env.DB.batch([
      env.DB.prepare(`
        insert or ignore into users (id, name, role, status)
        values ('usr_ai_success_owner', 'AI owner', 'admin', 'active')
      `),
      env.DB.prepare(`
        insert or replace into settings (key, value)
        values ('ai_processing_enabled', 'true')
      `),
    ]);

    const deliveries = [{
      id: `delivery_ai_product_${crypto.randomUUID()}`,
      subject: "Product launch update",
      body: "Notes about the upcoming product launch.",
    }, {
      id: `delivery_ai_spam_${crypto.randomUUID()}`,
      subject: "Spam offer",
      body: "An unsolicited and deceptive promotion.",
    }];
    for (const [index, delivery] of deliveries.entries()) {
      const rawObjectKey = `test/${delivery.id}.eml`;
      await env.MAIL_STORAGE.put(rawObjectKey, [
        "From: Sender <sender@example.net>",
        "To: me@example.test",
        `Subject: ${delivery.subject}`,
        `Message-ID: <${delivery.id}@example.net>`,
        // The spam claims to answer the product thread; it must not take it along.
        ...(index ? [`In-Reply-To: <${deliveries[0]!.id}@example.net>`] : []),
        "",
        delivery.body,
      ].join("\r\n"));
      await mailbox.enqueueInbound({
        id: delivery.id,
        mailboxId,
        rawObjectKey,
        envelopeFrom: "sender@example.net",
        envelopeTo: "me@example.test",
        receivedAt: Date.now() + index,
      });
    }

    const sendPush = vi.fn(async () => {});
    const runAi = vi.fn(async (
      _model: string,
      request: {
        input?: Array<{
          content?: Array<{ type?: string; file_data?: string }>;
        }>;
      },
    ) => {
      const fileData = request.input?.[0]?.content?.find(
        (content) => content.type === "input_file",
      )?.file_data;
      const rawEmail = fileData
        ? Buffer.from(fileData.split(",", 2)[1]!, "base64").toString()
        : "";
      const isSpam = rawEmail.includes("Spam offer");
      return {
        status: "completed",
        error: null,
        incomplete_details: null,
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({
              spam: isSpam,
              spamConfidence: isSpam ? 0.99 : 0.01,
              folderId: isSpam ? null : folder.folder.id,
              folderConfidence: isSpam ? 0 : 0.96,
              reason: isSpam ? "Unsolicited promotion" : "Product discussion",
            }),
          }],
        }],
      };
    });

    await runInDurableObject(mailbox, async (instance) => {
      type TestMailboxInstance = {
        alarm(): Promise<void>;
        bindings: Env;
      };
      const target = instance as unknown as TestMailboxInstance;
      const originalBindings = target.bindings;
      // The test config omits the always-remote AI binding. Replace bindings
      // only on this DO instance to exercise successful orchestration locally.
      target.bindings = {
        ...originalBindings,
        AI: { run: runAi },
        PUSH_NOTIFICATIONS: { send: sendPush },
      } as unknown as Env;
      try {
        await target.alarm();
        await target.alarm();
      } finally {
        target.bindings = originalBindings;
      }
    });

    const productMessage = await mailbox.getEmail(
      inboundMessageId(deliveries[0]!.id),
    );
    const spamMessage = await mailbox.getEmail(
      inboundMessageId(deliveries[1]!.id),
    );
    expect(productMessage?.aiClassificationJson).toMatchObject({
      spam: false,
      folderId: folder.folder.id,
    });
    expect(await mailbox.getConversationSnapshot(productMessage!.conversationId))
      .toMatchObject({ mailboxState: "active", folderId: folder.folder.id });
    expect(spamMessage?.aiClassificationJson).toMatchObject({
      spam: true,
      folderId: null,
    });
    expect(await mailbox.getConversationSnapshot(spamMessage!.conversationId))
      .toMatchObject({ mailboxState: "spam", folderId: null });
    expect(spamMessage!.conversationId).not.toBe(productMessage!.conversationId);
    expect(runAi).toHaveBeenCalledTimes(2);
    expect(runAi).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        extraHeaders: { "cf-aig-collect-log": "false" },
      }),
    );
    expect(sendPush).toHaveBeenCalledTimes(1);
  });

  it("does not classify inbound mail until MIME objects are stored", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const mailboxId = `mbx_ai_storage_failure_${crypto.randomUUID()}`;
    const mailbox = mailboxStub(env, mailboxId);
    const deliveryId = `delivery_ai_storage_failure_${crypto.randomUUID()}`;
    const rawObjectKey = `test/${deliveryId}.eml`;
    await env.DB.prepare(`
      insert or replace into settings (key, value)
      values ('ai_processing_enabled', 'true')
    `).run();
    await env.MAIL_STORAGE.put(rawObjectKey, [
      "From: Sender <sender@example.net>",
      "To: me@example.test",
      "Subject: Storage failure",
      `Message-ID: <${deliveryId}@example.net>`,
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>This body must be stored before classification.</p>",
    ].join("\r\n"));
    await mailbox.enqueueInbound({
      id: deliveryId,
      mailboxId,
      rawObjectKey,
      envelopeFrom: "sender@example.net",
      envelopeTo: "me@example.test",
      receivedAt: Date.now(),
    });

    const runAi = vi.fn(async () => {
      throw new Error("AI must not run before MIME storage completes");
    });
    await runInDurableObject(mailbox, async (instance) => {
      type TestMailboxInstance = {
        alarm(): Promise<void>;
        bindings: Env;
      };
      const target = instance as unknown as TestMailboxInstance;
      const originalBindings = target.bindings;
      target.bindings = {
        ...originalBindings,
        MAIL_STORAGE: {
          get: originalBindings.MAIL_STORAGE.get.bind(
            originalBindings.MAIL_STORAGE,
          ),
          put: vi.fn(async () => {
            throw new Error("R2 write failed");
          }),
        },
        AI: { run: runAi },
      } as unknown as Env;
      try {
        await target.alarm();
      } finally {
        target.bindings = originalBindings;
      }
    });

    expect(runAi).not.toHaveBeenCalled();
    expect(await mailbox.getEmail(inboundMessageId(deliveryId))).toBeNull();
    expect(errorLog).toHaveBeenCalledOnce();
    errorLog.mockRestore();
  });

  it("keeps AI mail pending for one retry, then falls back to Inbox", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const mailboxId = `mbx_ai_fallback_${crypto.randomUUID()}`;
    const mailbox = mailboxStub(env, mailboxId);
    const deliveryId = `delivery_ai_fallback_${crypto.randomUUID()}`;
    const rawObjectKey = `test/${deliveryId}.eml`;
    await env.DB.batch([
      env.DB.prepare(`
        insert or ignore into users (id, name, role, status)
        values ('usr_ai_owner', 'AI owner', 'admin', 'active')
      `),
      env.DB.prepare(`
        insert or replace into settings (key, value)
        values ('ai_processing_enabled', 'true')
      `),
    ]);
    await mailbox.setMailboxAiConfiguration({
      instructions: "Route product mail to Product.",
      confidenceThreshold: 75,
    });
    await env.MAIL_STORAGE.put(rawObjectKey, [
      "From: Sender <sender@example.net>",
      "To: me@example.test",
      "Subject: AI fallback",
      `Message-ID: <${deliveryId}@example.net>`,
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>The model is deliberately unavailable in the local test runtime.</p>",
    ].join("\r\n"));
    await mailbox.enqueueInbound({
      id: deliveryId,
      mailboxId,
      rawObjectKey,
      envelopeFrom: "sender@example.net",
      envelopeTo: "me@example.test",
      receivedAt: Date.now(),
    });

    await runDurableObjectAlarm(mailbox);
    expect(await mailbox.getEmail(inboundMessageId(deliveryId))).toBeNull();
    const bodyHtmlR2Key = `mailboxes/${mailboxId}/messages/${inboundMessageId(deliveryId)}/body.html`;
    expect(await env.MAIL_STORAGE.get(bodyHtmlR2Key)).not.toBeNull();
    await runInDurableObject(mailbox, (_instance, state) => {
      state.storage.sql.exec(
        "update pending_inbound set next_attempt_at = 0 where id = ?",
        deliveryId,
      );
    });

    await runDurableObjectAlarm(mailbox);
    const stored = await mailbox.getEmail(inboundMessageId(deliveryId));
    expect(stored).toMatchObject({
      subject: "AI fallback",
      aiClassificationJson: null,
    });
    expect(await mailbox.getConversationSnapshot(stored!.conversationId))
      .toMatchObject({ mailboxState: "active", folderId: null });
    expect(errorLog).toHaveBeenCalledTimes(2);
    errorLog.mockRestore();
  });

  it("searches every email in the selected folder and reactivates replied-to conversations", async () => {
    const mailbox = mailboxStub(env, `mbx_index_${crypto.randomUUID()}`);
    const userId = "usr_index";
    const now = Date.now();
    const targetConversationId = "conv_buried_target";
    const values: NewEmail[] = [
      incoming({
        id: "msg_buried_original",
        conversationId: targetConversationId,
        timelineAt: new Date(now - 100_000),
        bodyText: "The launch phrase is ultramarine falcon.",
      }),
      incoming({
        id: "msg_buried_latest",
        conversationId: targetConversationId,
        timelineAt: new Date(now - 99_000),
        bodyText: "Acknowledged with an outside-folder vermilion marker.",
      }),
      ...Array.from({ length: 30 }, (_, index) => incoming({
        id: `msg_filler_${index}`,
        conversationId: `conv_filler_${index}`,
        timelineAt: new Date(now - index * 1_000),
        bodyText: `Routine filler ${index}`,
      })),
    ];
    await mailbox.seedMailbox([{
      id: "project",
      name: "Project",
      sortOrder: 100,
    }], values, [{ id: targetConversationId, folderId: "project" }]);

    const firstPage = await mailbox.listConversations(userId, "inbox", 25, null, undefined);
    expect(firstPage?.items).toHaveLength(25);
    expect(firstPage?.next).not.toBeNull();
    expect(firstPage?.items.some(
      (item) => item.email.conversationId === targetConversationId,
    )).toBe(false);

    const search = await mailbox.listConversations(userId, "inbox", 25, null, "ultramarine");
    expect(search?.items.map((item) => item.email.conversationId)).toEqual([
      targetConversationId,
    ]);
    expect((await mailbox.listConversations(userId, "project", 25, null, "ultramarine"))?.items)
      .toHaveLength(1);
    expect((await mailbox.listConversations(userId, "inbox", 25, null, "vermilion"))?.items)
      .toHaveLength(1);
    expect((await mailbox.listConversations(userId, "project", 25, null, "vermilion"))?.items)
      .toHaveLength(1);

    expect(await mailbox.bulkUpdateConversations(
      [targetConversationId],
      "project",
      { mailboxState: "archive" },
    )).toBe(1);
    expect((await mailbox.listConversations(userId, "inbox", 25, null, "ultramarine"))?.items).toEqual([]);
    expect((await mailbox.listConversations(userId, "archive", 25, null, "ultramarine"))?.items).toHaveLength(1);
    expect((await mailbox.getConversationSnapshot(targetConversationId))?.mailboxState)
      .toBe("archive");

    await mailbox.insertEmail(incoming({
      id: "msg_buried_reply",
      conversationId: targetConversationId,
      timelineAt: new Date(now + 1_000),
      bodyText: "A new inbound reply.",
    }));
    expect((await mailbox.listConversations(userId, "inbox", 25, null, "ultramarine"))?.items).toHaveLength(1);
    expect((await mailbox.listConversations(userId, "archive", 25, null, "ultramarine"))?.items).toEqual([]);
    expect((await mailbox.getConversationSnapshot(targetConversationId))?.mailboxState)
      .toBe("active");
  });

  it("keeps message reads personal inside a shared mailbox", async () => {
    const mailbox = mailboxStub(env, `mbx_reads_${crypto.randomUUID()}`);
    const now = Date.now();
    const conversationId = "conv_shared_reads";
    await mailbox.seedMailbox([], [
      incoming({
        id: "msg_shared_first",
        conversationId,
        timelineAt: new Date(now - 2_000),
        bodyText: "First incoming message",
      }),
      incoming({
        id: "msg_shared_second",
        conversationId,
        timelineAt: new Date(now - 1_000),
        bodyText: "Second incoming message",
      }),
      {
        id: "msg_shared_reply",
        conversationId,
        direction: "outgoing",
        fromJson: [{ address: "me@example.test", name: null }],
        toJson: [{ address: "customer@example.net", name: null }],
        subject: "Re: Shared reads",
        timelineAt: new Date(now),
        transportState: "submitted",
      },
    ]);

    const initial = await mailbox.listConversations(
      "usr_reader_one",
      "inbox",
      25,
      null,
      undefined,
    );
    expect(initial?.items[0]).toMatchObject({
      messageCount: 3,
      unreadCount: 2,
    });
    expect((await mailbox.listFolders("usr_reader_one")).find(
      (folder) => folder.id === "inbox",
    )).toMatchObject({ totalCount: 1, unreadCount: 2 });

    expect(await mailbox.setMessageRead(
      "usr_reader_one",
      "msg_shared_first",
      true,
    )).toBe(true);
    expect((await mailbox.listConversations(
      "usr_reader_one",
      "inbox",
      25,
      null,
      undefined,
    ))?.items[0]?.unreadCount).toBe(1);
    expect((await mailbox.listConversations(
      "usr_reader_two",
      "inbox",
      25,
      null,
      undefined,
    ))?.items[0]?.unreadCount).toBe(2);

    await mailbox.setMessageRead("usr_reader_one", "msg_shared_second", true);
    expect((await mailbox.listFolders("usr_reader_one")).find(
      (folder) => folder.id === "inbox",
    )?.unreadCount).toBe(0);
    expect((await mailbox.listFolders("usr_reader_two")).find(
      (folder) => folder.id === "inbox",
    )?.unreadCount).toBe(2);
    expect((await mailbox.listConversations(
      "usr_reader_one",
      "inbox",
      25,
      null,
      undefined,
      true,
    ))?.items).toEqual([]);
    expect((await mailbox.listConversations(
      "usr_reader_two",
      "inbox",
      25,
      null,
      undefined,
      true,
    ))?.items).toHaveLength(1);
    expect((await mailbox.getConversationSnapshot(conversationId))?.readStates)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          emailId: "msg_shared_first",
          userId: "usr_reader_one",
        }),
        expect.objectContaining({
          emailId: "msg_shared_second",
          userId: "usr_reader_one",
        }),
      ]));

    await mailbox.setMessageRead("usr_reader_one", "msg_shared_second", false);
    expect((await mailbox.listConversations(
      "usr_reader_one",
      "inbox",
      25,
      null,
      undefined,
    ))?.items[0]?.unreadCount).toBe(1);

    expect(await mailbox.bulkSetConversationRead(
      "usr_reader_one",
      [conversationId],
      true,
    )).toBe(1);
    expect((await mailbox.getFolderCounts("usr_reader_one", "inbox"))?.unreadCount)
      .toBe(0);
    expect((await mailbox.listConversations(
      "usr_reader_two",
      "inbox",
      25,
      null,
      undefined,
    ))?.items[0]?.unreadCount).toBe(2);

    await mailbox.bulkSetConversationRead(
      "usr_reader_one",
      [conversationId],
      false,
    );
    expect((await mailbox.listConversations(
      "usr_reader_one",
      "inbox",
      25,
      null,
      undefined,
    ))?.items[0]?.unreadCount).toBe(1);
    expect(await mailbox.bulkSetConversationRead(
      "usr_reader_one",
      ["conv_missing"],
      true,
    )).toBe(0);
  });

  it("shows custom folders only while their conversations are in Inbox", async () => {
    const mailbox = mailboxStub(env, `mbx_global_unread_${crypto.randomUUID()}`);
    const conversationId = "conv_product_unread";
    await mailbox.seedMailbox([{
      id: "product",
      name: "Product",
      sortOrder: 100,
    }], [incoming({
      id: "msg_product_unread",
      conversationId,
      timelineAt: new Date(),
      bodyText: "Unread product message",
    })], [{ id: conversationId, folderId: "product" }]);

    expect((await mailbox.getFolderCounts("usr_product", "inbox"))?.unreadCount)
      .toBe(1);
    expect((await mailbox.getFolderCounts("usr_product", "product"))?.unreadCount)
      .toBe(1);
    expect(Object.fromEntries(
      (await mailbox.listFolders("usr_product")).map((folder) => [folder.id, folder]),
    )).toMatchObject({
      inbox: { totalCount: 1, unreadCount: 1 },
      product: { totalCount: 1, unreadCount: 1 },
      archive: { totalCount: 0, unreadCount: 0 },
    });

    expect(await mailbox.bulkUpdateConversations(
      [conversationId],
      "product",
      { mailboxState: "archive" },
    )).toBe(1);
    expect((await mailbox.getFolderCounts("usr_product", "inbox"))?.unreadCount)
      .toBe(0);
    expect(await mailbox.getFolderCounts("usr_product", "product"))
      .toEqual({ totalCount: 0, unreadCount: 0 });
    expect((await mailbox.getFolderCounts("usr_product", "archive"))?.unreadCount)
      .toBe(1);
    expect(Object.fromEntries(
      (await mailbox.listFolders("usr_product")).map((folder) => [folder.id, folder]),
    )).toMatchObject({
      inbox: { totalCount: 0, unreadCount: 0 },
      product: { totalCount: 0, unreadCount: 0 },
      archive: { totalCount: 1, unreadCount: 1 },
    });

    expect(await mailbox.bulkUpdateConversations(
      [conversationId],
      "archive",
      { folderId: "product" },
    )).toBe(1);
    expect((await mailbox.getFolderCounts("usr_product", "inbox"))?.unreadCount)
      .toBe(1);
    expect((await mailbox.getFolderCounts("usr_product", "product"))?.unreadCount)
      .toBe(1);
  });

  it("keeps outgoing-only conversations out of Inbox distribution folders", async () => {
    const mailbox = mailboxStub(env, `mbx_outgoing_distribution_${crypto.randomUUID()}`);
    const conversationId = "conv_outgoing_distribution";
    await mailbox.seedMailbox([{
      id: "product",
      name: "Product",
      sortOrder: 100,
    }], [{
      id: "msg_outgoing_distribution",
      conversationId,
      direction: "outgoing",
      fromJson: [{ address: "me@example.test", name: null }],
      toJson: [{ address: "customer@example.net", name: null }],
      subject: "Outgoing only",
      timelineAt: new Date(),
      transportState: "submitted",
    }]);

    expect(await mailbox.bulkUpdateConversations(
      [conversationId],
      "sent",
      { mailboxState: "archive" },
    )).toBe(1);
    expect(await mailbox.bulkUpdateConversations(
      [conversationId],
      "archive",
      { mailboxState: "active", folderId: null },
    )).toBe(0);
    expect(await mailbox.bulkUpdateConversations(
      [conversationId],
      "archive",
      { mailboxState: "active" },
    )).toBe(1);
    expect(await mailbox.bulkUpdateConversations(
      [conversationId],
      "sent",
      { folderId: "product" },
    )).toBe(0);
    expect(await mailbox.bulkUpdateConversations(
      [conversationId],
      "sent",
      { folderId: "missing" },
    )).toBeNull();
    expect(await mailbox.bulkSetConversationRead(
      "usr_outgoing_distribution",
      [conversationId],
      false,
    )).toBe(0);
    expect((await mailbox.listConversations(
      "usr_outgoing_distribution",
      "sent",
      25,
      null,
      undefined,
    ))?.items).toMatchObject([{ hasIncoming: false }]);
    expect(await mailbox.getConversationSnapshot(conversationId)).toMatchObject({
      mailboxState: "active",
      folderId: null,
      readStates: [],
    });
  });

  it("applies bulk actions once and cleans permanently deleted message objects", async () => {
    const mailbox = mailboxStub(env, `mbx_bulk_${crypto.randomUUID()}`);
    const now = Date.now();
    const objectKeys = [
      `test/bulk/${crypto.randomUUID()}/body.html`,
      `test/bulk/${crypto.randomUUID()}/raw.eml`,
      `test/bulk/${crypto.randomUUID()}/attachment.txt`,
    ];
    await Promise.all(objectKeys.map((key) => env.MAIL_STORAGE.put(key, "stored")));
    await mailbox.seedMailbox([], [
      {
        ...incoming({
          id: "msg_bulk_first",
          conversationId: "conv_bulk_first",
          timelineAt: new Date(now - 1_000),
          bodyText: "First bulk message",
        }),
        bodyHtmlR2Key: objectKeys[0],
        rawMimeR2Key: objectKeys[1],
        attachmentsJson: [{
          id: "att_bulk_first",
          r2Key: objectKeys[2]!,
          filename: "attachment.txt",
          contentType: "text/plain",
          size: 6,
          contentId: null,
          disposition: "attachment",
          delivery: "attached",
          downloadTokenHash: null,
          downloadExpiresAt: null,
        }],
      },
      incoming({
        id: "msg_bulk_second",
        conversationId: "conv_bulk_second",
        timelineAt: new Date(now),
        bodyText: "Second bulk message",
      }),
    ]);
    const conversationIds = ["conv_bulk_first", "conv_bulk_second"];

    expect(await mailbox.bulkSetConversationRead(
      "usr_bulk_one",
      conversationIds,
      true,
    )).toBe(2);
    expect((await mailbox.listFolders("usr_bulk_one")).find(
      (folder) => folder.id === "inbox",
    )?.unreadCount).toBe(0);
    expect((await mailbox.listFolders("usr_bulk_two")).find(
      (folder) => folder.id === "inbox",
    )?.unreadCount).toBe(2);

    expect(await mailbox.bulkUpdateConversations(
      conversationIds,
      "inbox",
      { mailboxState: "archive" },
    )).toBe(2);
    await expect(mailbox.permanentlyDeleteConversations(conversationIds))
      .resolves.toMatchObject({ outcome: "not_in_trash" });
    expect(await mailbox.bulkUpdateConversations(
      conversationIds,
      "inbox",
      { mailboxState: "trash" },
    )).toBe(0);
    expect(await mailbox.bulkUpdateConversations(
      conversationIds,
      "archive",
      { mailboxState: "trash" },
    )).toBe(2);
    await expect(mailbox.permanentlyDeleteConversations(conversationIds))
      .resolves.toEqual({ outcome: "deleted", deletedCount: 2 });
    expect(await mailbox.getConversationSnapshot("conv_bulk_first")).toBeNull();
    expect(await mailbox.getConversationSnapshot("conv_bulk_second")).toBeNull();
    expect(await mailbox.shouldSuppressPush(
      "msg_bulk_first",
      "usr_bulk_one",
    )).toBe(true);

    await runDurableObjectAlarm(mailbox);
    for (const objectKey of objectKeys) {
      expect(await env.MAIL_STORAGE.get(objectKey)).toBeNull();
    }
  });

  it("does not recreate permanently deleted email from pending inbound work", async () => {
    const mailboxId = `mbx_pending_delete_${crypto.randomUUID()}`;
    const mailbox = mailboxStub(env, mailboxId);
    const deliveryId = `pending_delete_${crypto.randomUUID()}`;
    const messageId = inboundMessageId(deliveryId);
    const conversationId = "conv_pending_delete";
    const rawObjectKey = `test/pending-delete/${crypto.randomUUID()}/raw.eml`;
    const now = Date.now();
    await env.MAIL_STORAGE.put(rawObjectKey, [
      "From: Pending Sender <sender@example.net>",
      "To: me@example.test",
      "Subject: Pending delete",
      "Message-ID: <pending-delete@example.net>",
      "",
      "This message must not return.",
    ].join("\r\n"));
    await mailbox.enqueueInbound({
      id: deliveryId,
      mailboxId,
      rawObjectKey,
      envelopeFrom: "sender@example.net",
      envelopeTo: "me@example.test",
      receivedAt: now,
    });
    await mailbox.seedMailbox([], [{
      ...incoming({
        id: messageId,
        conversationId,
        timelineAt: new Date(now),
        bodyText: "Already visible",
      }),
      rawMimeR2Key: rawObjectKey,
    }], [{ id: conversationId, mailboxState: "trash" }]);

    await expect(mailbox.permanentlyDeleteConversations([conversationId]))
      .resolves.toEqual({ outcome: "deleted", deletedCount: 1 });
    expect(await mailbox.getEmail(messageId)).toBeNull();

    await runDurableObjectAlarm(mailbox);
    expect(await mailbox.getEmail(messageId)).toBeNull();
    expect(await env.MAIL_STORAGE.get(rawObjectKey)).toBeNull();
  });

  it("applies every bulk action beyond the SQLite parameter limit", async () => {
    const mailbox = mailboxStub(env, `mbx_large_bulk_${crypto.randomUUID()}`);
    const now = Date.now();
    const conversationIds = Array.from(
      { length: 101 },
      (_, index) => `conv_large_bulk_${index}`,
    );
    await mailbox.seedMailbox([], conversationIds.map((conversationId, index) =>
      incoming({
        id: `msg_large_bulk_${index}`,
        conversationId,
        timelineAt: new Date(now + index),
        bodyText: `Large bulk message ${index}`,
      })
    ));

    expect(await mailbox.bulkSetConversationRead(
      "usr_large_bulk",
      conversationIds,
      true,
    )).toBe(conversationIds.length);
    expect(await mailbox.bulkUpdateConversations(
      conversationIds,
      "inbox",
      { mailboxState: "archive" },
    )).toBe(conversationIds.length);
    expect(await mailbox.bulkUpdateConversations(
      conversationIds,
      "archive",
      { mailboxState: "trash" },
    )).toBe(conversationIds.length);
    await expect(mailbox.permanentlyDeleteConversations(conversationIds))
      .resolves.toEqual({
        outcome: "deleted",
        deletedCount: conversationIds.length,
      });
  });

  it("keeps legacy shared objects until their last referencing email is deleted", async () => {
    const mailbox = mailboxStub(env, `mbx_shared_object_${crypto.randomUUID()}`);
    const objectKey = `test/shared-object/${crypto.randomUUID()}/attachment.txt`;
    const attachment = {
      id: "att_shared",
      r2Key: objectKey,
      filename: "shared.txt",
      contentType: "text/plain",
      size: 6,
      contentId: null,
      disposition: "attachment" as const,
      delivery: "attached" as const,
      downloadTokenHash: null,
      downloadExpiresAt: null,
    };
    await env.MAIL_STORAGE.put(objectKey, "shared");
    await mailbox.seedMailbox([], [
      {
        ...incoming({
          id: "msg_shared_object_source",
          conversationId: "conv_shared_object_source",
          timelineAt: new Date(Date.now() - 1_000),
          bodyText: "Source",
        }),
        attachmentsJson: [attachment],
      },
      {
        ...incoming({
          id: "msg_shared_object_survivor",
          conversationId: "conv_shared_object_survivor",
          timelineAt: new Date(),
          bodyText: "Survivor",
        }),
        attachmentsJson: [{ ...attachment, id: "att_shared_copy" }],
      },
    ]);

    expect(await mailbox.bulkUpdateConversations(
      ["conv_shared_object_source"],
      "inbox",
      { mailboxState: "trash" },
    )).toBe(1);
    await expect(mailbox.permanentlyDeleteConversations([
      "conv_shared_object_source",
    ])).resolves.toMatchObject({ outcome: "deleted" });
    expect(await env.MAIL_STORAGE.get(objectKey)).not.toBeNull();

    expect(await mailbox.bulkUpdateConversations(
      ["conv_shared_object_survivor"],
      "inbox",
      { mailboxState: "trash" },
    )).toBe(1);
    await expect(mailbox.permanentlyDeleteConversations([
      "conv_shared_object_survivor",
    ])).resolves.toMatchObject({ outcome: "deleted" });
    expect(await runDurableObjectAlarm(mailbox)).toBe(true);
    expect(await env.MAIL_STORAGE.get(objectKey)).toBeNull();
  });
});
