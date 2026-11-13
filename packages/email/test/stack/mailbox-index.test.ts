import { describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import { inboundMessageId } from "@open-workspace/email/worker/mail/inbound.ts";
import type { NewEmail } from "@open-workspace/email/worker/mailbox/schema.ts";
import { z } from "zod";

import { runAlarmUntil } from "./mailbox-helpers.ts";
import { pollUntil } from "./poll.ts";
import {
  env,
  hooks,
  mailbox as mailboxStub,
  useFreshWorkspace,
} from "./workspace.ts";

useFreshWorkspace();

/** A push job that sends a new-mail notification (the others carry JMAP state). */
const pushDispatch = z.looseObject({ type: z.literal("dispatch") });

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
    const mailbox = mailboxStub(`mbx_message_pages_${crypto.randomUUID()}`);
    const conversationId = "conv_message_pages";

    const messages = Array.from({ length: 30 }, (_, index) =>
      incoming({
        id: `msg_page_${String(index).padStart(2, "0")}`,
        conversationId,
        timelineAt: new Date(1_700_000_000_000 + index),
        bodyText: `Message ${index}`,
      })
    );

    await mailbox.seedMailbox([], messages);
    const [oldest] = messages;
    await mailbox.setMessageRead(
      "usr_message_pages",
      required(oldest, "the conversation has messages").id,
      true
    );

    const first = await mailbox.getConversationPageSnapshot(
      conversationId,
      "usr_message_pages",
      10,
      null
    );

    expect(first).toMatchObject({
      messageCount: 30,
      unreadCount: 29,
      hasIncoming: true,
    });
    expect(first?.messages.map((message) => message.id)).toEqual(
      messages.slice(20).map((message) => message.id)
    );
    expect(first?.next).toBeTruthy();

    const second = await mailbox.getConversationPageSnapshot(
      conversationId,
      "usr_message_pages",
      10,
      required(first, "the first page exists").next
    );

    expect(second?.messages.map((message) => message.id)).toEqual(
      messages.slice(10, 20).map((message) => message.id)
    );
    expect(second?.messageCount).toBe(30);
    expect(second?.unreadCount).toBe(29);
  });

  it("applies successful AI folder and spam decisions before notifications", async () => {
    const mailboxId = `mbx_ai_success_${crypto.randomUUID()}`;
    const mailbox = mailboxStub(mailboxId);
    const folder = await mailbox.createFolder("fld_product", "Product");
    expect(folder.status).toBe("ok");

    if (folder.status !== "ok") {
      throw new Error("Product folder was not created");
    }

    // The test configuration names no model; this mailbox gets a fake one, and
    // its push jobs are recorded. Installed before mail arrives, as alarms
    // fire on their own.
    const decision = (spam: boolean) =>
      JSON.stringify({
        spam,
        spamConfidence: spam ? 0.99 : 0.01,
        folderId: spam ? null : folder.folder.id,
        folderConfidence: spam ? 0 : 0.96,
        reason: spam ? "Unsolicited promotion" : "Product discussion",
      });

    await mailbox.testFake({
      push: "capture",
      classifier: {
        mode: "rules",
        reasoning: "medium",
        rules: [{ includes: "Spam offer", text: decision(true) }],
        fallback: decision(false),
      },
    });

    await env.DB.batch([
      env.DB.prepare(`
        insert or ignore into users (id, name, role, status)
        values ('usr_ai_success_owner', 'AI owner', 'admin', 'active')
      `),
    ]);

    const productDelivery = {
      id: `delivery_ai_product_${crypto.randomUUID()}`,
      subject: "Product launch update",
      body: "Notes about the upcoming product launch.",
    };

    const spamDelivery = {
      id: `delivery_ai_spam_${crypto.randomUUID()}`,
      subject: "Spam offer",
      body: "An unsolicited and deceptive promotion.",
    };

    // Each delivery's MIME is stored before it is queued; the two are
    // independent, and receivedAt keeps their order in the queue.
    const deliver = async (delivery: typeof productDelivery, index: number) => {
      const rawObjectKey = `test/${delivery.id}.eml`;
      await env.MAIL_STORAGE.put(
        rawObjectKey,
        [
          "From: Sender <sender@example.net>",
          "To: me@example.test",
          `Subject: ${delivery.subject}`,
          `Message-ID: <${delivery.id}@example.net>`,
          "",
          delivery.body,
        ].join("\r\n")
      );
      await mailbox.enqueueInbound({
        id: delivery.id,
        mailboxId,
        rawObjectKey,
        envelopeFrom: "sender@example.net",
        envelopeTo: "me@example.test",
        receivedAt: Date.now() + index,
      });
    };

    await Promise.all([deliver(productDelivery, 0), deliver(spamDelivery, 1)]);

    await runAlarmUntil(
      mailboxId,
      async () =>
        (await mailbox.getEmail(inboundMessageId(productDelivery.id))) &&
        (await mailbox.getEmail(inboundMessageId(spamDelivery.id)))
    );

    const productMessage = required(
      await mailbox.getEmail(inboundMessageId(productDelivery.id)),
      "the product mail is stored"
    );

    const spamMessage = required(
      await mailbox.getEmail(inboundMessageId(spamDelivery.id)),
      "the spam mail is stored"
    );

    expect(productMessage.aiClassificationJson).toMatchObject({
      spam: false,
      folderId: folder.folder.id,
    });
    expect(
      await mailbox.getConversationSnapshot(productMessage.conversationId)
    ).toMatchObject({ mailboxState: "active", folderId: folder.folder.id });
    expect(spamMessage.aiClassificationJson).toMatchObject({
      spam: true,
      folderId: null,
    });
    expect(
      await mailbox.getConversationSnapshot(spamMessage.conversationId)
    ).toMatchObject({ mailboxState: "spam", folderId: null });
    const calls = await mailbox.testCalls();
    const generated = calls.filter((call) => call.kind === "doGenerate");
    expect(generated).toHaveLength(2);
    expect(generated[0]?.data).toMatchObject({ reasoning: "medium" });
    // One new-mail notification; JMAP state jobs go through the same queue.
    expect(
      calls.filter(
        (call) =>
          call.kind === "PUSH_NOTIFICATIONS.send" &&
          pushDispatch.safeParse(call.data).success
      )
    ).toHaveLength(1);
  });

  it("does not classify inbound mail until MIME objects are stored", async () => {
    const mailboxId = `mbx_ai_storage_failure_${crypto.randomUUID()}`;
    const mailbox = mailboxStub(mailboxId);
    const deliveryId = `delivery_ai_storage_failure_${crypto.randomUUID()}`;
    const rawObjectKey = `test/${deliveryId}.eml`;
    await env.MAIL_STORAGE.put(
      rawObjectKey,
      [
        "From: Sender <sender@example.net>",
        "To: me@example.test",
        "Subject: Storage failure",
        `Message-ID: <${deliveryId}@example.net>`,
        "MIME-Version: 1.0",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>This body must be stored before classification.</p>",
      ].join("\r\n")
    );
    // The mailbox cannot write to R2 (reads still work), and asking for the
    // classification model fails the test's expectation if it happens.
    await mailbox.testFake({
      mailStorage: { put: "fail" },
      classifier: { mode: "throw" },
    });
    await mailbox.enqueueInbound({
      id: deliveryId,
      mailboxId,
      rawObjectKey,
      envelopeFrom: "sender@example.net",
      envelopeTo: "me@example.test",
      receivedAt: Date.now(),
    });

    expect(await hooks.runAlarm(mailboxId)).toBe(true);
    const calls = await mailbox.testCalls();
    expect(
      calls.filter((call) => call.kind === "MAIL_STORAGE.put").length
    ).toBeGreaterThan(0);
    expect(calls.filter((call) => call.kind === "classificationModel")).toEqual(
      []
    );
    expect(await mailbox.getEmail(inboundMessageId(deliveryId))).toBeNull();
    expect(calls.filter((call) => call.kind === "console.error")).toHaveLength(
      1
    );
  });

  it("keeps AI mail pending for one retry, then falls back to Inbox", async () => {
    const mailboxId = `mbx_ai_fallback_${crypto.randomUUID()}`;
    const mailbox = mailboxStub(mailboxId);
    const deliveryId = `delivery_ai_fallback_${crypto.randomUUID()}`;
    const rawObjectKey = `test/${deliveryId}.eml`;
    await env.DB.batch([
      env.DB.prepare(`
        insert or ignore into users (id, name, role, status)
        values ('usr_ai_owner', 'AI owner', 'admin', 'active')
      `),
    ]);
    await mailbox.setMailboxAiConfiguration({
      instructions: "Route product mail to Product.",
      confidenceThreshold: 75,
    });
    await env.MAIL_STORAGE.put(
      rawObjectKey,
      [
        "From: Sender <sender@example.net>",
        "To: me@example.test",
        "Subject: AI fallback",
        `Message-ID: <${deliveryId}@example.net>`,
        "MIME-Version: 1.0",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>The model is deliberately unavailable in the local test runtime.</p>",
      ].join("\r\n")
    );
    // A model whose every call fails, before the alarm can fire.
    await mailbox.testFake({ classifier: { mode: "unavailable" } });
    await mailbox.enqueueInbound({
      id: deliveryId,
      mailboxId,
      rawObjectKey,
      envelopeFrom: "sender@example.net",
      envelopeTo: "me@example.test",
      receivedAt: Date.now(),
    });

    expect(await hooks.runAlarm(mailboxId)).toBe(true);
    expect(await mailbox.getEmail(inboundMessageId(deliveryId))).toBeNull();
    const bodyHtmlR2Key = `mailboxes/${mailboxId}/messages/${inboundMessageId(deliveryId)}/body.html`;
    expect(await env.MAIL_STORAGE.get(bodyHtmlR2Key)).not.toBeNull();
    await hooks.mailboxSql(
      mailboxId,
      "update pending_inbound set next_attempt_at = 0 where id = ?",
      deliveryId
    );

    const stored = required(
      await runAlarmUntil(mailboxId, () =>
        mailbox.getEmail(inboundMessageId(deliveryId))
      ),
      "the retried mail is stored"
    );

    expect(stored).toMatchObject({
      subject: "AI fallback",
      aiClassificationJson: null,
    });
    expect(
      await mailbox.getConversationSnapshot(stored.conversationId)
    ).toMatchObject({ mailboxState: "active", folderId: null });
    expect(
      (await mailbox.testCalls()).filter(
        (call) => call.kind === "console.error"
      )
    ).toHaveLength(2);
  });

  it("counts an attempt before parsing, so a delivery that kills the mailbox expires", async () => {
    const mailboxId = `mbx_inbound_killed_${crypto.randomUUID()}`;
    const mailbox = mailboxStub(mailboxId);
    const deliveryId = `delivery_inbound_killed_${crypto.randomUUID()}`;
    const rawObjectKey = `test/${deliveryId}.eml`;
    await env.MAIL_STORAGE.put(
      rawObjectKey,
      [
        "From: Sender <sender@example.net>",
        "To: me@example.test",
        "Subject: Kills the mailbox",
        `Message-ID: <${deliveryId}@example.net>`,
        "",
        "Processing this message never finishes.",
      ].join("\r\n")
    );
    // Processing ends past parsing with the object restarted, as when the
    // runtime kills it for CPU or memory: no catch runs.
    await mailbox.testFake({ classifier: { mode: "abort" } });
    await mailbox.enqueueInbound({
      id: deliveryId,
      mailboxId,
      rawObjectKey,
      envelopeFrom: "sender@example.net",
      envelopeTo: "me@example.test",
      receivedAt: Date.now(),
    });

    const pending = z.object({
      attempts: z.number(),
      next_attempt_at: z.number(),
    });

    // The alarm fails with the object; the attempt it counted remains.
    const attempted = required(
      await pollUntil(
        async () => {
          await hooks.runAlarm(mailboxId).catch(() => false);

          const [row] = await hooks.mailboxRows(
            mailboxId,
            pending,
            "select attempts, next_attempt_at from pending_inbound where id = ?",
            deliveryId
          );

          return row && row.attempts > 0 ? row : null;
        },
        { failure: "The killed attempt was not recorded" }
      ),
      "the killed attempt is recorded"
    );

    // Backed off behind newer mail, not picked first on the next wake.
    expect(attempted.next_attempt_at).toBeGreaterThan(Date.now());
    expect(await mailbox.getEmail(inboundMessageId(deliveryId))).toBeNull();

    // A day later the message is stored as unreadable without another parse.
    await hooks.mailboxSql(
      mailboxId,
      "update pending_inbound set received_at = ?, next_attempt_at = 0 where id = ?",
      Date.now() - 24 * 60 * 60 * 1000 - 1,
      deliveryId
    );

    const stored = required(
      await runAlarmUntil(mailboxId, () =>
        mailbox.getEmail(inboundMessageId(deliveryId))
      ),
      "the expired delivery is stored"
    );

    expect(stored).toMatchObject({
      subject: "(unreadable message)",
      bodyText: expect.stringContaining("did not finish within 24 hours"),
      rawMimeR2Key: rawObjectKey,
    });
    expect(
      await hooks.mailboxSql(
        mailboxId,
        "select id from pending_inbound where id = ?",
        deliveryId
      )
    ).toEqual([]);
  });

  it("searches every email in the selected folder and reactivates replied-to conversations", async () => {
    const mailbox = mailboxStub(`mbx_index_${crypto.randomUUID()}`);
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
      ...Array.from({ length: 30 }, (_, index) =>
        incoming({
          id: `msg_filler_${index}`,
          conversationId: `conv_filler_${index}`,
          timelineAt: new Date(now - index * 1000),
          bodyText: `Routine filler ${index}`,
        })
      ),
    ];

    await mailbox.seedMailbox(
      [
        {
          id: "project",
          name: "Project",
          sortOrder: 100,
        },
      ],
      values,
      [{ id: targetConversationId, folderId: "project" }]
    );

    const firstPage = await mailbox.listConversations(
      userId,
      "inbox",
      25,
      null,
      undefined
    );

    expect(firstPage?.items).toHaveLength(25);
    expect(firstPage?.next).not.toBeNull();
    expect(
      firstPage?.items.some(
        (item) => item.email.conversationId === targetConversationId
      )
    ).toBe(false);

    const search = await mailbox.listConversations(
      userId,
      "inbox",
      25,
      null,
      "ultramarine"
    );

    expect(search?.items.map((item) => item.email.conversationId)).toEqual([
      targetConversationId,
    ]);
    expect(
      (
        await mailbox.listConversations(
          userId,
          "project",
          25,
          null,
          "ultramarine"
        )
      )?.items
    ).toHaveLength(1);
    expect(
      (await mailbox.listConversations(userId, "inbox", 25, null, "vermilion"))
        ?.items
    ).toHaveLength(1);
    expect(
      (
        await mailbox.listConversations(
          userId,
          "project",
          25,
          null,
          "vermilion"
        )
      )?.items
    ).toHaveLength(1);

    expect(
      await mailbox.bulkUpdateConversations([targetConversationId], "project", {
        mailboxState: "archive",
      })
    ).toBe(1);
    expect(
      (
        await mailbox.listConversations(
          userId,
          "inbox",
          25,
          null,
          "ultramarine"
        )
      )?.items
    ).toEqual([]);
    expect(
      (
        await mailbox.listConversations(
          userId,
          "archive",
          25,
          null,
          "ultramarine"
        )
      )?.items
    ).toHaveLength(1);
    expect(
      (await mailbox.getConversationSnapshot(targetConversationId))
        ?.mailboxState
    ).toBe("archive");

    await mailbox.insertEmail(
      incoming({
        id: "msg_buried_reply",
        conversationId: targetConversationId,
        timelineAt: new Date(now + 1000),
        bodyText: "A new inbound reply.",
      })
    );
    expect(
      (
        await mailbox.listConversations(
          userId,
          "inbox",
          25,
          null,
          "ultramarine"
        )
      )?.items
    ).toHaveLength(1);
    expect(
      (
        await mailbox.listConversations(
          userId,
          "archive",
          25,
          null,
          "ultramarine"
        )
      )?.items
    ).toEqual([]);
    expect(
      (await mailbox.getConversationSnapshot(targetConversationId))
        ?.mailboxState
    ).toBe("active");
  });

  it("projects each insert onto its conversation and the search index, as stored", async () => {
    const mailbox = mailboxStub(`mbx_projection_${crypto.randomUUID()}`);

    const conversation = () =>
      mailbox.testSql(
        "select latest_email_id, timeline_at, mailbox_state, has_incoming, has_outgoing from conversations where id = 'conv_projection'"
      );

    const at = 1_700_000_000_000;

    const message = (
      id: string,
      timelineAt: number,
      direction: "incoming" | "outgoing" = "incoming"
    ): NewEmail => {
      const email: NewEmail = {
        ...incoming({
          id,
          conversationId: "conv_projection",
          timelineAt: new Date(at + timelineAt),
          bodyText: `Body of ${id}`,
        }),
        direction,
      };

      if (direction === "outgoing") email.transportState = "submitted";

      return email;
    };

    await mailbox.insertEmail(message("msg_b", 10));
    expect(await conversation()).toEqual([
      {
        latest_email_id: "msg_b",
        timeline_at: at + 10,
        mailbox_state: "active",
        has_incoming: 1,
        has_outgoing: 0,
      },
    ]);
    // An older message arriving late does not move the conversation; a tie goes to the larger id.
    await mailbox.insertEmail(message("msg_a", 5));
    await mailbox.insertEmail(message("msg_a2", 10));
    expect(await conversation()).toMatchObject([
      { latest_email_id: "msg_b", timeline_at: at + 10 },
    ]);
    await mailbox.insertEmail(message("msg_c", 10));
    expect(await conversation()).toMatchObject([
      { latest_email_id: "msg_c", timeline_at: at + 10 },
    ]);

    // Spam stays spam for incoming mail and comes back for a reply sent from here.
    await mailbox.testSql(
      "update conversations set mailbox_state = 'spam' where id = 'conv_projection'"
    );
    await mailbox.insertEmail(message("msg_d", 20));
    expect(await conversation()).toMatchObject([
      { mailbox_state: "spam", has_outgoing: 0 },
    ]);
    await mailbox.insertEmail(message("msg_e", 30, "outgoing"));
    expect(await conversation()).toEqual([
      {
        latest_email_id: "msg_e",
        timeline_at: at + 30,
        mailbox_state: "active",
        has_incoming: 1,
        has_outgoing: 1,
      },
    ]);

    // Archive and Trash come back for any new message.
    const expectNewMessageReactivates = async (
      state: "archive" | "trash",
      id: string
    ) => {
      await mailbox.testSql(
        `update conversations set mailbox_state = '${state}' where id = 'conv_projection'`
      );
      await mailbox.insertEmail(message(id, 40));
      expect(await conversation()).toMatchObject([{ mailbox_state: "active" }]);
    };

    await expectNewMessageReactivates("archive", "msg_f");
    await expectNewMessageReactivates("trash", "msg_g");

    // One search row per message: subject, every address list as stored, body and preview.
    const rows = await mailbox.testSql(
      "select email_id, conversation_id, subject, addresses, body from email_search where email_id = 'msg_b'"
    );

    expect(rows).toEqual([
      {
        email_id: "msg_b",
        conversation_id: "conv_projection",
        subject: "Subject msg_b",
        addresses:
          '[{"address":"msg_b@example.net","name":null}] [] [{"address":"me@example.test","name":null}] [] []',
        body: "Body of msg_b Body of msg_b",
      },
    ]);
    expect(
      await mailbox.testSql("select count(*) as n from email_search")
    ).toEqual([{ n: 8 }]);
    // A duplicate insert adds nothing.
    await mailbox.insertEmail(message("msg_b", 10));
    expect(
      await mailbox.testSql("select count(*) as n from email_search")
    ).toEqual([{ n: 8 }]);
  });

  it("keeps message reads personal inside a shared mailbox", async () => {
    const mailbox = mailboxStub(`mbx_reads_${crypto.randomUUID()}`);
    const now = Date.now();
    const conversationId = "conv_shared_reads";
    await mailbox.seedMailbox(
      [],
      [
        incoming({
          id: "msg_shared_first",
          conversationId,
          timelineAt: new Date(now - 2000),
          bodyText: "First incoming message",
        }),
        incoming({
          id: "msg_shared_second",
          conversationId,
          timelineAt: new Date(now - 1000),
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
      ]
    );

    const initial = await mailbox.listConversations(
      "usr_reader_one",
      "inbox",
      25,
      null,
      undefined
    );

    expect(initial?.items[0]).toMatchObject({
      messageCount: 3,
      unreadCount: 2,
    });
    expect(
      (await mailbox.listFolders("usr_reader_one")).find(
        (folder) => folder.id === "inbox"
      )
    ).toMatchObject({ totalCount: 1, unreadCount: 2 });

    expect(
      await mailbox.setMessageRead("usr_reader_one", "msg_shared_first", true)
    ).toEqual({ version: expect.any(Number) });
    expect(
      (
        await mailbox.listConversations(
          "usr_reader_one",
          "inbox",
          25,
          null,
          undefined
        )
      )?.items[0]?.unreadCount
    ).toBe(1);
    expect(
      (
        await mailbox.listConversations(
          "usr_reader_two",
          "inbox",
          25,
          null,
          undefined
        )
      )?.items[0]?.unreadCount
    ).toBe(2);

    await mailbox.setMessageRead("usr_reader_one", "msg_shared_second", true);
    expect(
      (await mailbox.listFolders("usr_reader_one")).find(
        (folder) => folder.id === "inbox"
      )?.unreadCount
    ).toBe(0);
    expect(
      (await mailbox.listFolders("usr_reader_two")).find(
        (folder) => folder.id === "inbox"
      )?.unreadCount
    ).toBe(2);
    expect(
      (
        await mailbox.listConversations(
          "usr_reader_one",
          "inbox",
          25,
          null,
          undefined,
          true
        )
      )?.items
    ).toEqual([]);
    expect(
      (
        await mailbox.listConversations(
          "usr_reader_two",
          "inbox",
          25,
          null,
          undefined,
          true
        )
      )?.items
    ).toHaveLength(1);
    expect(
      (await mailbox.getConversationSnapshot(conversationId))?.readStates
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          emailId: "msg_shared_first",
          userId: "usr_reader_one",
        }),
        expect.objectContaining({
          emailId: "msg_shared_second",
          userId: "usr_reader_one",
        }),
      ])
    );

    await mailbox.setMessageRead("usr_reader_one", "msg_shared_second", false);
    expect(
      (
        await mailbox.listConversations(
          "usr_reader_one",
          "inbox",
          25,
          null,
          undefined
        )
      )?.items[0]?.unreadCount
    ).toBe(1);

    expect(
      await mailbox.bulkSetConversationRead(
        "usr_reader_one",
        [conversationId],
        true
      )
    ).toBe(1);
    expect(
      (await mailbox.getFolderCounts("usr_reader_one", "inbox"))?.unreadCount
    ).toBe(0);
    expect(
      (
        await mailbox.listConversations(
          "usr_reader_two",
          "inbox",
          25,
          null,
          undefined
        )
      )?.items[0]?.unreadCount
    ).toBe(2);

    await mailbox.bulkSetConversationRead(
      "usr_reader_one",
      [conversationId],
      false
    );
    expect(
      (
        await mailbox.listConversations(
          "usr_reader_one",
          "inbox",
          25,
          null,
          undefined
        )
      )?.items[0]?.unreadCount
    ).toBe(1);
    expect(
      await mailbox.bulkSetConversationRead(
        "usr_reader_one",
        ["conv_missing"],
        true
      )
    ).toBe(0);
  });

  it("shows custom folders only while their conversations are in Inbox", async () => {
    const mailbox = mailboxStub(`mbx_global_unread_${crypto.randomUUID()}`);
    const conversationId = "conv_product_unread";
    await mailbox.seedMailbox(
      [
        {
          id: "product",
          name: "Product",
          sortOrder: 100,
        },
      ],
      [
        incoming({
          id: "msg_product_unread",
          conversationId,
          timelineAt: new Date(),
          bodyText: "Unread product message",
        }),
      ],
      [{ id: conversationId, folderId: "product" }]
    );

    expect(
      (await mailbox.getFolderCounts("usr_product", "inbox"))?.unreadCount
    ).toBe(1);
    expect(
      (await mailbox.getFolderCounts("usr_product", "product"))?.unreadCount
    ).toBe(1);
    expect(
      Object.fromEntries(
        (await mailbox.listFolders("usr_product")).map((folder) => [
          folder.id,
          folder,
        ])
      )
    ).toMatchObject({
      inbox: { totalCount: 1, unreadCount: 1 },
      product: { totalCount: 1, unreadCount: 1 },
      archive: { totalCount: 0, unreadCount: 0 },
    });

    expect(
      await mailbox.bulkUpdateConversations([conversationId], "product", {
        mailboxState: "archive",
      })
    ).toBe(1);
    expect(
      (await mailbox.getFolderCounts("usr_product", "inbox"))?.unreadCount
    ).toBe(0);
    expect(await mailbox.getFolderCounts("usr_product", "product")).toEqual({
      totalCount: 0,
      unreadCount: 0,
    });
    expect(
      (await mailbox.getFolderCounts("usr_product", "archive"))?.unreadCount
    ).toBe(1);
    expect(
      Object.fromEntries(
        (await mailbox.listFolders("usr_product")).map((folder) => [
          folder.id,
          folder,
        ])
      )
    ).toMatchObject({
      inbox: { totalCount: 0, unreadCount: 0 },
      product: { totalCount: 0, unreadCount: 0 },
      archive: { totalCount: 1, unreadCount: 1 },
    });

    expect(
      await mailbox.bulkUpdateConversations([conversationId], "archive", {
        folderId: "product",
      })
    ).toBe(1);
    expect(
      (await mailbox.getFolderCounts("usr_product", "inbox"))?.unreadCount
    ).toBe(1);
    expect(
      (await mailbox.getFolderCounts("usr_product", "product"))?.unreadCount
    ).toBe(1);
  });

  it("keeps outgoing-only conversations out of Inbox distribution folders", async () => {
    const mailbox = mailboxStub(
      `mbx_outgoing_distribution_${crypto.randomUUID()}`
    );

    const conversationId = "conv_outgoing_distribution";
    await mailbox.seedMailbox(
      [
        {
          id: "product",
          name: "Product",
          sortOrder: 100,
        },
      ],
      [
        {
          id: "msg_outgoing_distribution",
          conversationId,
          direction: "outgoing",
          fromJson: [{ address: "me@example.test", name: null }],
          toJson: [{ address: "customer@example.net", name: null }],
          subject: "Outgoing only",
          timelineAt: new Date(),
          transportState: "submitted",
        },
      ]
    );

    expect(
      await mailbox.bulkUpdateConversations([conversationId], "sent", {
        mailboxState: "archive",
      })
    ).toBe(1);
    expect(
      await mailbox.bulkUpdateConversations([conversationId], "archive", {
        mailboxState: "active",
        folderId: null,
      })
    ).toBe(0);
    expect(
      await mailbox.bulkUpdateConversations([conversationId], "archive", {
        mailboxState: "active",
      })
    ).toBe(1);
    expect(
      await mailbox.bulkUpdateConversations([conversationId], "sent", {
        folderId: "product",
      })
    ).toBe(0);
    expect(
      await mailbox.bulkUpdateConversations([conversationId], "sent", {
        folderId: "missing",
      })
    ).toBeNull();
    expect(
      await mailbox.bulkSetConversationRead(
        "usr_outgoing_distribution",
        [conversationId],
        false
      )
    ).toBe(0);
    expect(
      (
        await mailbox.listConversations(
          "usr_outgoing_distribution",
          "sent",
          25,
          null,
          undefined
        )
      )?.items
    ).toMatchObject([{ hasIncoming: false }]);
    expect(await mailbox.getConversationSnapshot(conversationId)).toMatchObject(
      {
        mailboxState: "active",
        folderId: null,
        readStates: [],
      }
    );
  });

  it("applies bulk actions once and cleans permanently deleted message objects", async () => {
    const mailboxId = `mbx_bulk_${crypto.randomUUID()}`;
    const mailbox = mailboxStub(mailboxId);
    const now = Date.now();

    const [bodyKey, rawKey, attachmentKey] = [
      `test/bulk/${crypto.randomUUID()}/body.html`,
      `test/bulk/${crypto.randomUUID()}/raw.eml`,
      `test/bulk/${crypto.randomUUID()}/attachment.txt`,
    ];

    const objectKeys = [bodyKey, rawKey, attachmentKey];

    await Promise.all(
      objectKeys.map((key) => env.MAIL_STORAGE.put(key, "stored"))
    );
    await mailbox.seedMailbox(
      [],
      [
        {
          ...incoming({
            id: "msg_bulk_first",
            conversationId: "conv_bulk_first",
            timelineAt: new Date(now - 1000),
            bodyText: "First bulk message",
          }),
          bodyHtmlR2Key: bodyKey,
          rawMimeR2Key: rawKey,
          attachmentsJson: [
            {
              id: "att_bulk_first",
              r2Key: attachmentKey,
              filename: "attachment.txt",
              contentType: "text/plain",
              size: 6,
              contentId: null,
              disposition: "attachment",
              delivery: "attached",
              downloadTokenHash: null,
              downloadExpiresAt: null,
            },
          ],
        },
        incoming({
          id: "msg_bulk_second",
          conversationId: "conv_bulk_second",
          timelineAt: new Date(now),
          bodyText: "Second bulk message",
        }),
      ]
    );
    const conversationIds = ["conv_bulk_first", "conv_bulk_second"];

    expect(
      await mailbox.bulkSetConversationRead(
        "usr_bulk_one",
        conversationIds,
        true
      )
    ).toBe(2);
    expect(
      (await mailbox.listFolders("usr_bulk_one")).find(
        (folder) => folder.id === "inbox"
      )?.unreadCount
    ).toBe(0);
    expect(
      (await mailbox.listFolders("usr_bulk_two")).find(
        (folder) => folder.id === "inbox"
      )?.unreadCount
    ).toBe(2);

    expect(
      await mailbox.bulkUpdateConversations(conversationIds, "inbox", {
        mailboxState: "archive",
      })
    ).toBe(2);
    await expect(
      mailbox.permanentlyDeleteConversations(conversationIds)
    ).resolves.toMatchObject({ outcome: "not_in_trash" });
    expect(
      await mailbox.bulkUpdateConversations(conversationIds, "inbox", {
        mailboxState: "trash",
      })
    ).toBe(0);
    expect(
      await mailbox.bulkUpdateConversations(conversationIds, "archive", {
        mailboxState: "trash",
      })
    ).toBe(2);
    await expect(
      mailbox.permanentlyDeleteConversations(conversationIds)
    ).resolves.toEqual({ outcome: "deleted", deletedCount: 2 });
    expect(await mailbox.getConversationSnapshot("conv_bulk_first")).toBeNull();
    expect(
      await mailbox.getConversationSnapshot("conv_bulk_second")
    ).toBeNull();
    expect(
      await mailbox.shouldSuppressPush("msg_bulk_first", "usr_bulk_one")
    ).toBe(true);

    await runAlarmUntil(mailboxId, async () =>
      (
        await Promise.all(objectKeys.map((key) => env.MAIL_STORAGE.get(key)))
      ).every((object) => object === null)
    );

    expect(
      await Promise.all(objectKeys.map((key) => env.MAIL_STORAGE.get(key)))
    ).toEqual([null, null, null]);
  });

  it("does not recreate permanently deleted email from pending inbound work", async () => {
    const mailboxId = `mbx_pending_delete_${crypto.randomUUID()}`;
    const mailbox = mailboxStub(mailboxId);
    const deliveryId = `pending_delete_${crypto.randomUUID()}`;
    const messageId = inboundMessageId(deliveryId);
    const conversationId = "conv_pending_delete";
    const rawObjectKey = `test/pending-delete/${crypto.randomUUID()}/raw.eml`;
    const now = Date.now();
    await env.MAIL_STORAGE.put(
      rawObjectKey,
      [
        "From: Pending Sender <sender@example.net>",
        "To: me@example.test",
        "Subject: Pending delete",
        "Message-ID: <pending-delete@example.net>",
        "",
        "This message must not return.",
      ].join("\r\n")
    );
    await mailbox.enqueueInbound({
      id: deliveryId,
      mailboxId,
      rawObjectKey,
      envelopeFrom: "sender@example.net",
      envelopeTo: "me@example.test",
      receivedAt: now,
    });
    await mailbox.seedMailbox(
      [],
      [
        {
          ...incoming({
            id: messageId,
            conversationId,
            timelineAt: new Date(now),
            bodyText: "Already visible",
          }),
          rawMimeR2Key: rawObjectKey,
        },
      ],
      [{ id: conversationId, mailboxState: "trash" }]
    );

    await expect(
      mailbox.permanentlyDeleteConversations([conversationId])
    ).resolves.toEqual({ outcome: "deleted", deletedCount: 1 });
    expect(await mailbox.getEmail(messageId)).toBeNull();

    await runAlarmUntil(
      mailboxId,
      async () =>
        (await env.MAIL_STORAGE.get(rawObjectKey)) === null &&
        (await hooks.mailboxSql(mailboxId, "select * from pending_inbound"))
          .length === 0
    );
    expect(await mailbox.getEmail(messageId)).toBeNull();
    expect(await env.MAIL_STORAGE.get(rawObjectKey)).toBeNull();
  });

  it("applies every bulk action beyond the SQLite parameter limit", async () => {
    const mailbox = mailboxStub(`mbx_large_bulk_${crypto.randomUUID()}`);
    const now = Date.now();

    const conversationIds = Array.from(
      { length: 101 },
      (_, index) => `conv_large_bulk_${index}`
    );

    await mailbox.seedMailbox(
      [],
      conversationIds.map((conversationId, index) =>
        incoming({
          id: `msg_large_bulk_${index}`,
          conversationId,
          timelineAt: new Date(now + index),
          bodyText: `Large bulk message ${index}`,
        })
      )
    );

    expect(
      await mailbox.bulkSetConversationRead(
        "usr_large_bulk",
        conversationIds,
        true
      )
    ).toBe(conversationIds.length);
    expect(
      await mailbox.bulkUpdateConversations(conversationIds, "inbox", {
        mailboxState: "archive",
      })
    ).toBe(conversationIds.length);
    expect(
      await mailbox.bulkUpdateConversations(conversationIds, "archive", {
        mailboxState: "trash",
      })
    ).toBe(conversationIds.length);
    await expect(
      mailbox.permanentlyDeleteConversations(conversationIds)
    ).resolves.toEqual({
      outcome: "deleted",
      deletedCount: conversationIds.length,
    });
  });

  it("keeps shared objects until their last referencing email is deleted", async () => {
    const mailboxId = `mbx_shared_object_${crypto.randomUUID()}`;
    const mailbox = mailboxStub(mailboxId);
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
    await mailbox.seedMailbox(
      [],
      [
        {
          ...incoming({
            id: "msg_shared_object_source",
            conversationId: "conv_shared_object_source",
            timelineAt: new Date(Date.now() - 1000),
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
      ]
    );

    expect(
      await mailbox.bulkUpdateConversations(
        ["conv_shared_object_source"],
        "inbox",
        { mailboxState: "trash" }
      )
    ).toBe(1);
    await expect(
      mailbox.permanentlyDeleteConversations(["conv_shared_object_source"])
    ).resolves.toMatchObject({ outcome: "deleted" });
    expect(await env.MAIL_STORAGE.get(objectKey)).not.toBeNull();

    expect(
      await mailbox.bulkUpdateConversations(
        ["conv_shared_object_survivor"],
        "inbox",
        { mailboxState: "trash" }
      )
    ).toBe(1);
    await expect(
      mailbox.permanentlyDeleteConversations(["conv_shared_object_survivor"])
    ).resolves.toMatchObject({ outcome: "deleted" });
    // The last delete schedules the object's cleanup.
    expect(await mailbox.testAlarm()).not.toBeNull();
    await runAlarmUntil(
      mailboxId,
      async () => (await env.MAIL_STORAGE.get(objectKey)) === null
    );
    expect(await env.MAIL_STORAGE.get(objectKey)).toBeNull();
  });
});
