import { describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import type { MailboxState } from "@open-workspace/email/worker/mailbox/folder-model.ts";
import type { NewEmail } from "@open-workspace/email/worker/mailbox/schema.ts";
import { z } from "zod";

import { pollUntil } from "./poll.ts";
import {
  hooks,
  mailbox as mailboxStub,
  useFreshWorkspace,
} from "./workspace.ts";

useFreshWorkspace();

const DAY_MS = 24 * 60 * 60 * 1000;

function incoming(conversationId: string): NewEmail {
  return {
    id: `msg_${conversationId}`,
    conversationId,
    direction: "incoming",
    fromJson: [{ address: "sender@example.net", name: null }],
    toJson: [{ address: "me@example.test", name: null }],
    subject: `Subject ${conversationId}`,
    timelineAt: new Date(),
    transportState: "received",
  };
}

/** A fresh mailbox holding one conversation per `[id, state]`. */
async function seeded(conversations: [string, MailboxState][]) {
  const mailboxId = `mbx_retention_${crypto.randomUUID()}`;
  const mailbox = mailboxStub(mailboxId);

  await mailbox.seedMailbox(
    [],
    conversations.map(([id]) => incoming(id)),
    conversations.map(([id, mailboxState]) => ({ id, mailboxState }))
  );

  return { mailboxId, mailbox };
}

async function stateChangedAt(mailboxId: string, conversationId: string) {
  const [row] = await hooks.mailboxRows(
    mailboxId,
    z.object({ state_changed_at: z.number().nullable() }),
    "select state_changed_at from conversations where id = ?",
    conversationId
  );

  return required(row, `${conversationId} exists`).state_changed_at;
}

async function remainingIds(mailboxId: string) {
  const rows = await hooks.mailboxRows(
    mailboxId,
    z.object({ id: z.string() }),
    "select id from conversations order by id"
  );

  return rows.map((row) => row.id);
}

/** Moves conversations into `state` the way the app does. */
function move(
  mailbox: ReturnType<typeof mailboxStub>,
  ids: string[],
  from: string,
  state: MailboxState
) {
  return mailbox.bulkUpdateConversations(ids, from, { mailboxState: state });
}

describe("moving into Spam", () => {
  it("starts the clock once and wakes when the 30-day default is due", async () => {
    const { mailboxId, mailbox } = await seeded([["conv_a", "active"]]);

    // Email({ retention: { trash: 7 } }) in stack.ts reaches the worker.
    expect((await mailbox.folderView("usr_test")).retention).toEqual({
      trash: 7,
      spam: 30,
    });
    expect(await mailbox.testAlarm()).toBeNull();

    const before = Date.now();
    await move(mailbox, ["conv_a"], "inbox", "spam");

    const stamped = required(
      await stateChangedAt(mailboxId, "conv_a"),
      "moving to Spam stamps conv_a"
    );

    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(
      await pollUntil(() => mailbox.testAlarm(), {
        failure: "moving mail into Spam set no alarm",
      })
    ).toBe(stamped + 30 * DAY_MS);

    // A move within Spam is not entering it, so the clock keeps running.
    await move(mailbox, ["conv_a"], "spam", "spam");

    expect(await stateChangedAt(mailboxId, "conv_a")).toBe(stamped);
  });
});

describe("emptyFolder", () => {
  it("deletes Trash in batches of 100 and leaves Spam alone", async () => {
    const trash = Array.from(
      { length: 101 },
      (_, index): [string, MailboxState] => [
        `conv_trash_${String(index).padStart(3, "0")}`,
        "trash",
      ]
    );

    const { mailboxId, mailbox } = await seeded([
      ...trash,
      ["conv_spam", "spam"],
      ["conv_inbox", "active"],
    ]);

    expect(await mailbox.emptyFolder("trash")).toEqual({
      deleted: 100,
      remaining: 1,
    });
    expect(await mailbox.emptyFolder("trash")).toEqual({
      deleted: 1,
      remaining: 0,
    });
    expect(await remainingIds(mailboxId)).toEqual(["conv_inbox", "conv_spam"]);

    expect(await mailbox.emptyFolder("spam")).toEqual({
      deleted: 1,
      remaining: 0,
    });
    expect(await remainingIds(mailboxId)).toEqual(["conv_inbox"]);
  });
});

describe("retention", () => {
  it("deletes Trash past 7 days and wakes for the next one", async () => {
    const { mailboxId, mailbox } = await seeded([
      ["conv_old", "active"],
      ["conv_new", "active"],
      ["conv_inbox", "active"],
    ]);

    await move(mailbox, ["conv_old", "conv_new"], "inbox", "trash");

    // The move stamped both; shift those stamps back as if days had passed.
    await hooks.mailboxSql(
      mailboxId,
      "update conversations set state_changed_at = state_changed_at - ? where id = ?",
      8 * DAY_MS,
      "conv_old"
    );
    await hooks.mailboxSql(
      mailboxId,
      "update conversations set state_changed_at = state_changed_at - ? where id = ?",
      6 * DAY_MS,
      "conv_new"
    );

    const newAt = required(
      await stateChangedAt(mailboxId, "conv_new"),
      "conv_new is stamped"
    );

    await hooks.runAlarm(mailboxId);

    expect(await remainingIds(mailboxId)).toEqual(["conv_inbox", "conv_new"]);
    expect(await mailbox.testAlarm()).toBe(newAt + 7 * DAY_MS);
  });
});
