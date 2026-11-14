import { describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import { inboundMessageId } from "@open-workspace/email/worker/mail/inbound.ts";
import type {
  ruleInputSchema,
  ruleTestSchema,
} from "@open-workspace/email/worker/mail/rules.ts";
import { z } from "zod";

import { readJson } from "./json.ts";
import { bootstrapAdmin, firstMailboxId } from "./mail-flow-helpers.ts";
import { runAlarmUntil } from "./mailbox-helpers.ts";
import {
  env,
  hooks,
  mailbox as mailboxStub,
  useFreshWorkspace,
  worker,
} from "./workspace.ts";

useFreshWorkspace();

/** Delivers raw mail through the mailbox's inbound queue; the stored message. */
async function deliver(
  mailboxId: string,
  input: {
    id: string;
    from: string;
    to: string;
    /** The address it was delivered to, when To names someone else (Bcc). */
    envelopeTo?: string;
    subject: string;
    headers?: string[];
  }
) {
  const mailbox = mailboxStub(mailboxId);
  const rawObjectKey = `test/${input.id}.eml`;

  await env.MAIL_STORAGE.put(
    rawObjectKey,
    [
      `From: <${input.from}>`,
      `To: ${input.to}`,
      `Subject: ${input.subject}`,
      `Message-ID: <${input.id}@example.net>`,
      ...(input.headers ?? []),
      "",
      "Hello",
    ].join("\r\n")
  );
  await mailbox.enqueueInbound({
    id: input.id,
    mailboxId,
    rawObjectKey,
    envelopeFrom: input.from,
    envelopeTo: input.envelopeTo ?? input.to,
    receivedAt: Date.now(),
  });

  return required(
    await runAlarmUntil(mailboxId, () =>
      mailbox.getEmail(inboundMessageId(input.id))
    ),
    `${input.id} is stored`
  );
}

const placeRow = z.object({
  mailbox_state: z.string(),
  folder_id: z.string().nullable(),
  split_from_conversation_id: z.string().nullable(),
});

async function placeOf(mailboxId: string, emailId: string) {
  const [row] = await hooks.mailboxRows(
    mailboxId,
    placeRow,
    `select c.mailbox_state, c.folder_id, e.split_from_conversation_id
     from emails e join conversations c on c.id = e.conversation_id
     where e.id = ?`,
    emailId
  );

  return required(row, `${emailId} has a conversation`);
}

/** A JSON request body, as the routes under test take it. */
type ApiBody =
  | z.input<typeof ruleInputSchema>
  | z.input<typeof ruleTestSchema>
  | { name: string }
  | { pattern: string };

function api(cookie: string, path: string, method = "GET", body?: ApiBody) {
  return worker.fetch(
    new Request(`http://example.test/api/mail${path}`, {
      method,
      headers: { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

const ruleBody = z.object({ rule: z.object({ id: z.string() }) });

describe("mailbox rules", () => {
  it("file, mark read and discard new mail; blocks still win", async () => {
    const cookie = await bootstrapAdmin();
    const mailboxId = await firstMailboxId(cookie);

    const list = await readJson(
      await api(cookie, "/mailboxes"),
      z.object({
        mailboxes: z.array(
          z.looseObject({ id: z.string(), address: z.string() })
        ),
      })
    );

    const own = required(
      list.mailboxes.find((item) => item.id === mailboxId),
      "the admin's mailbox is listed"
    ).address;

    const folder = await readJson(
      await api(cookie, `/mailboxes/${mailboxId}/folders`, "POST", {
        name: "Receipts",
      }),
      z.object({ folder: z.object({ id: z.string() }) })
    );

    // A rule can only move to an existing custom folder.
    expect(
      (
        await api(cookie, `/mailboxes/${mailboxId}/rules`, "POST", {
          name: "Nowhere",
          conditions: [{ type: "hasAttachment" }],
          actions: [{ type: "moveToFolder", folderId: "inbox" }],
        })
      ).status
    ).toBe(400);

    const create = async (body: ApiBody) =>
      (
        await readJson(
          await api(cookie, `/mailboxes/${mailboxId}/rules`, "POST", body),
          ruleBody
        )
      ).rule.id;

    await create({
      name: "Receipts",
      conditions: [{ type: "subject", op: "contains", value: "receipt" }],
      actions: [
        { type: "moveToFolder", folderId: folder.folder.id },
        { type: "markRead" },
      ],
    });
    await create({
      name: "Bcc",
      conditions: [
        { type: "recipient", op: "equals", value: own },
        { type: "subject", op: "contains", value: "minutes" },
      ],
      actions: [{ type: "archive" }],
    });
    await create({
      name: "Noise",
      conditions: [{ type: "from", op: "domain", value: "noise.example" }],
      actions: [{ type: "trash" }],
    });

    const rules = await readJson(
      await api(cookie, `/mailboxes/${mailboxId}/rules`),
      z.object({ rules: z.array(z.object({ name: z.string() })) })
    );

    expect(rules.rules.map((rule) => rule.name)).toEqual([
      "Receipts",
      "Bcc",
      "Noise",
    ]);

    // Filed into the rule's folder and read for every member.
    const receipt = await deliver(mailboxId, {
      id: "rule-receipt",
      from: "shop@example.net",
      to: own,
      subject: "Your receipt",
    });

    expect(await placeOf(mailboxId, receipt.id)).toMatchObject({
      mailbox_state: "active",
      folder_id: folder.folder.id,
    });
    expect(
      await hooks.mailboxSql(
        mailboxId,
        "select user_id from email_read_states where email_id = ?",
        receipt.id
      )
    ).toHaveLength(1);

    const tested = await readJson(
      await api(cookie, `/mailboxes/${mailboxId}/rules/test`, "POST", {
        match: "all",
        conditions: [{ type: "subject", op: "equals", value: "your RECEIPT" }],
      }),
      z.object({ matches: z.number(), scanned: z.number() })
    );

    expect(tested).toEqual({ matches: 1, scanned: 1 });

    // Mail Bcc'd to the mailbox names it only in the envelope.
    const bcc = await deliver(mailboxId, {
      id: "rule-bcc",
      from: "vendor@example.net",
      to: "list@elsewhere.example",
      envelopeTo: own,
      subject: "Minutes",
    });

    expect((await placeOf(mailboxId, bcc.id)).mailbox_state).toBe("archive");

    // A reply a rule sends to Trash gets its own conversation; the thread
    // it names stays in Inbox and is recorded for the way back.
    const thread = await deliver(mailboxId, {
      id: "rule-thread",
      from: "friend@example.net",
      to: own,
      subject: "Lunch?",
    });

    const reply = await deliver(mailboxId, {
      id: "rule-thread-reply",
      from: "someone@noise.example",
      to: own,
      subject: "Re: Lunch?",
      headers: ["In-Reply-To: <rule-thread@example.net>"],
    });

    expect(reply.conversationId).not.toBe(thread.conversationId);
    expect(await placeOf(mailboxId, reply.id)).toEqual({
      mailbox_state: "trash",
      folder_id: null,
      split_from_conversation_id: thread.conversationId,
    });
    expect((await placeOf(mailboxId, thread.id)).mailbox_state).toBe("active");

    // A blocked sender goes to Spam whatever the rules say: no folder, no
    // read mark.
    expect(
      (
        await api(cookie, `/mailboxes/${mailboxId}/blocked-senders`, "POST", {
          pattern: "pest@example.net",
        })
      ).status
    ).toBe(200);

    const blocked = await deliver(mailboxId, {
      id: "rule-blocked",
      from: "pest@example.net",
      to: own,
      subject: "Another receipt",
    });

    expect(await placeOf(mailboxId, blocked.id)).toMatchObject({
      mailbox_state: "spam",
      folder_id: null,
    });
    expect(
      await hooks.mailboxSql(
        mailboxId,
        "select user_id from email_read_states where email_id = ?",
        blocked.id
      )
    ).toHaveLength(0);

    // Deleting a rule's folder marks the rule in the list.
    expect(
      (
        await api(
          cookie,
          `/mailboxes/${mailboxId}/folders/${folder.folder.id}`,
          "DELETE"
        )
      ).status
    ).toBe(200);

    const afterDelete = await readJson(
      await api(cookie, `/mailboxes/${mailboxId}/rules`),
      z.object({
        rules: z.array(
          z.object({ name: z.string(), folderDeleted: z.boolean() })
        ),
      })
    );

    expect(
      afterDelete.rules
        .filter((rule) => rule.folderDeleted)
        .map((rule) => rule.name)
    ).toEqual(["Receipts"]);
  });
});
